#!/bin/sh
# 主機 3(正式區 WSL)NetOps PA 專用 CA:本人以 root 執行,私鑰不離開主機 3、不顯示(AGENT.md §7.5;需求方 2026-11-16 決定)。
#   sudo sh host3-pa-pki.sh init              建 CA「GigaNexus NetOps PA CA (prod)」(已存在就不動)
#   sudo sh host3-pa-pki.sh server [--renew]  簽接收端 server.crt / server.key(SAN IP:10.10.130.122;--renew 先備份再重簽)
#   sudo sh host3-pa-pki.sh sign-csr <CSR>    簽 PA-560 管理介面的 CSR(PA 上產生,私鑰留在 PA);SAN 照 CSR,必須含 IP 10.10.115.35(不可有其他 IP);簽前核對 CSR 的 SHA-256
#   sudo sh host3-pa-pki.sh status            列出 CA、server.crt 與已簽發憑證的到期日
#
# 與 Gateway :9443 的臨時 PKI(giga-api-gateway-bff deploy/host3-prod-temp-pki.sh)分開,互不信任。
# 檔案(docs/PA-FORWARDING-SPEC.md 附錄 F.6):
#   /srv/giganexus/netops-pa-ca/        root 700(不掛進任何容器)
#     ca.key                            CA 私鑰,root 400
#     ca.crt                            CA 憑證(公開)
#     issued/<序號>.crt、issued.txt      已簽發憑證的副本與清單(撤銷 / 到期追蹤用)
#   /srv/giganexus/netops-pa-tls/       host3-set-pa-secrets.sh 建立,唯讀掛到 netops-pa 的 /run/pa-tls
#     pa-mgmt-ca.pem                    = ca.crt,644:netops-pa 驗證 PA-560 管理介面(PA_CA_FILE)
#     server.crt                        644;server.key 1000:1000 400:接收端 HTTPS :51293、Syslog SSL :51294
# 演算法:全部 RSA + SHA-256(PAN-OS 12.1 的 Trusted Root、管理介面 SSL/TLS Service Profile、Syslog SSL / HTTPS 用戶端都支援;
#   CA RSA 4096 / 10 年,接收端 RSA 3072 / 825 天,PA 的 CSR 接受 RSA ≥ 2048 或 ECDSA P-256 / P-384,簽 825 天)。
# 之後要做用戶端憑證(mTLS,PF G8)時,同一個 CA 另加子指令簽 clientAuth,把 ca.crt 複製成 pa-client-ca.pem 即可;CA 不限定用途。
set -eu
umask 077

SERVER_IP=10.10.130.122
PA_IP=10.10.115.35
CA_NAME="GigaNexus NetOps PA CA (prod)"
CA_DIR=/srv/giganexus/netops-pa-ca
TLS_DIR=/srv/giganexus/netops-pa-tls
ENV_FILE=/srv/giganexus/deploy/netops.env
CA_DAYS=3650
LEAF_DAYS=825
SERVER_BITS=3072

die() { echo "錯誤:$*" >&2; exit 1; }
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[ "$(id -u)" = 0 ] || die "請用 sudo 執行"
command -v openssl >/dev/null || die "WSL 沒有 openssl"
grep -qx 'GW_ENV=prod' "$ENV_FILE" 2>/dev/null || die "$ENV_FILE 不是正式區設定(主機 3 先依 RUNBOOK-prod.md §2 執行 host3-set-secrets.sh)"

serial() { echo "0x$(openssl rand -hex 16)"; }
fp() { openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2; }
enddate() { openssl x509 -in "$1" -noout -enddate | cut -d= -f2; }
need_ca() {
  [ -f "$CA_DIR/ca.key" ] && [ -f "$CA_DIR/ca.crt" ] || die "CA 還沒建立,先執行 init"
  # CA 目錄與私鑰必須仍是 root 擁有、其他人不可存取,且不是符號連結
  [ ! -L "$CA_DIR" ] && [ ! -L "$CA_DIR/ca.key" ] || die "$CA_DIR 或 ca.key 是符號連結,停止"
  [ "$(stat -c '%u %a' "$CA_DIR")" = "0 700" ] || die "$CA_DIR 權限不是 root 700($(stat -c '%U %a' "$CA_DIR")),先人工確認"
  [ "$(stat -c '%u %a' "$CA_DIR/ca.key")" = "0 400" ] || die "ca.key 權限不是 root 400,先人工確認"
}
# 印出 CSR 裡的文字前去掉控制字元(避免終端機跳脫序列)
clean() { printf '%s' "$1" | LC_ALL=C tr -cd '[:print:]'; }
need_tls_dir() { [ -d "$TLS_DIR" ] || die "沒有 $TLS_DIR(先執行 host3-set-pa-secrets.sh,它會建立憑證目錄)"; }

# 在 CA 目錄內的暫存目錄工作,結束時清掉(私鑰不經過 /tmp)
WORK=""
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM PIPE
mkwork() { WORK="$(mktemp -d "$CA_DIR/.work.XXXXXX")"; }
# openssl 失敗時印出它的錯誤訊息(不含私鑰)再停止;要在 mkwork 之後用
ossl() { openssl "$@" 2>"$WORK/err" || { cat "$WORK/err" >&2; return 1; }; }

# 用 CA 簽 $1(CSR)→ $2(憑證),擴充欄位檔 $3;記錄到 issued.txt
sign() {
  s="$(serial)"
  ossl x509 -req -in "$1" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" -set_serial "$s" \
    -days "$LEAF_DAYS" -sha256 -extfile "$3" -out "$2" || die "簽發失敗"
  openssl verify -CAfile "$CA_DIR/ca.crt" "$2" >/dev/null || die "簽發的憑證驗證失敗"
  hex="$(openssl x509 -in "$2" -noout -serial | cut -d= -f2)"
  install -m 644 -o root -g root "$2" "$CA_DIR/issued/$hex.crt"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$hex" "$(enddate "$2")" \
    "$(openssl x509 -in "$2" -noout -subject | sed 's/^subject=//')" "$4" >> "$CA_DIR/issued.txt"
  chmod 644 "$CA_DIR/issued.txt"
}

print_env() {
  echo
  echo "== 寫進 $ENV_FILE 的設定(已有同名行時改那一行;改完依 RUNBOOK-prod.md §4 重跑 deploy-prod)=="
  echo "PA_CA_FILE=/run/pa-tls/pa-mgmt-ca.pem"
  echo "PA_TLS_CERT_FILE=/run/pa-tls/server.crt"
  echo "PA_TLS_KEY_FILE=/run/pa-tls/server.key"
  echo "PA_HOST=$PA_IP"
  echo "(不可設 PA_TLS_INSECURE;有 server.crt 就不需要 PA_RECEIVE_PLAINTEXT)"
}

cmd_init() {
  need_tls_dir
  if [ -f "$CA_DIR/ca.key" ] || [ -f "$CA_DIR/ca.crt" ]; then
    [ -f "$CA_DIR/ca.key" ] && [ -f "$CA_DIR/ca.crt" ] || die "$CA_DIR 只有 ca.key 或 ca.crt 其中一個,先人工確認,不自動覆寫"
    echo "CA 已存在,不重建:$(openssl x509 -in "$CA_DIR/ca.crt" -noout -subject | sed 's/^subject=//')"
  else
    install -d -m 700 -o root -g root "$CA_DIR" "$CA_DIR/issued"
    mkwork
    cat > "$WORK/ca.ext" <<'EOF'
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EOF
    ossl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$WORK/ca.key" || die "產生 CA 私鑰失敗"
    ossl req -new -key "$WORK/ca.key" -subj "/O=GigaNexus/OU=NetOps/CN=$CA_NAME" -out "$WORK/ca.csr" || die "產生 CA 憑證要求失敗"
    ossl x509 -req -in "$WORK/ca.csr" -signkey "$WORK/ca.key" -set_serial "$(serial)" -days "$CA_DAYS" -sha256 \
      -extfile "$WORK/ca.ext" -out "$WORK/ca.crt" || die "產生 CA 憑證失敗"
    install -m 400 -o root -g root "$WORK/ca.key" "$CA_DIR/ca.key"
    install -m 644 -o root -g root "$WORK/ca.crt" "$CA_DIR/ca.crt"
    echo "已建立 CA:$CA_NAME(到期 $(enddate "$CA_DIR/ca.crt"))"
  fi
  [ -d "$CA_DIR/issued" ] || install -d -m 700 -o root -g root "$CA_DIR/issued"
  install -m 644 -o root -g root "$CA_DIR/ca.crt" "$TLS_DIR/pa-mgmt-ca.pem"
  echo "CA 憑證(公開,交給網通匯入 PA 為 Trusted Root CA):$TLS_DIR/pa-mgmt-ca.pem"
  echo "主體:$(openssl x509 -in "$CA_DIR/ca.crt" -noout -subject | sed 's/^subject=//')"
  echo "到期:$(enddate "$CA_DIR/ca.crt")"
  echo "SHA-256 指紋(網通匯入後核對;PA 沒顯示指紋時核對主體與到期):$(fp "$CA_DIR/ca.crt")"
}

cmd_server() {
  case "${1:-}" in ''|--renew) ;; *) die "server 只接受 --renew:$1" ;; esac
  need_ca; need_tls_dir
  if [ -f "$TLS_DIR/server.crt" ] || [ -f "$TLS_DIR/server.key" ]; then
    old="$(enddate "$TLS_DIR/server.crt" 2>/dev/null)" || old=""
    [ "${1:-}" = "--renew" ] || die "$TLS_DIR 已有 server.crt / server.key(到期 ${old:-不明});要重簽加 --renew"
  fi
  mkwork
  cat > "$WORK/s.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$SERVER_IP
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
  ossl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:"$SERVER_BITS" -out "$WORK/server.key" || die "產生接收端私鑰失敗"
  ossl req -new -key "$WORK/server.key" -subj "/O=GigaNexus/OU=NetOps/CN=$SERVER_IP" -out "$WORK/server.csr" || die "產生接收端憑證要求失敗"
  sign "$WORK/server.csr" "$WORK/server.crt" "$WORK/s.ext" "IP:$SERVER_IP"
  # 新檔先以暫存名寫進同一個目錄,舊檔備份到 CA 目錄(root 700,不留在掛進容器的目錄)後再以 mv 換上,縮短沒有憑證的空檔
  install -m 644 -o root -g root "$WORK/server.crt" "$TLS_DIR/.server.crt.new"
  install -m 400 -o 1000 -g 1000 "$WORK/server.key" "$TLS_DIR/.server.key.new"
  if [ -f "$TLS_DIR/server.crt" ] || [ -f "$TLS_DIR/server.key" ]; then
    TS="$(date +%Y%m%d%H%M%S)"
    for f in server.crt server.key; do if [ -f "$TLS_DIR/$f" ]; then cp -p "$TLS_DIR/$f" "$CA_DIR/$f.bak-$TS"; fi; done
    echo "舊的 server.crt / server.key 已備份到 $CA_DIR/*.bak-$TS"
  fi
  mv -f "$TLS_DIR/.server.key.new" "$TLS_DIR/server.key"
  mv -f "$TLS_DIR/.server.crt.new" "$TLS_DIR/server.crt"
  echo "已簽發接收端憑證:$TLS_DIR/server.crt(SAN IP:$SERVER_IP,到期 $(enddate "$TLS_DIR/server.crt"))"
  ls -l "$TLS_DIR"
  echo "netops-pa 已在執行時要重建才會載入新憑證:main「Run pipeline」帶 NETOPS_PA_RECREATE=1,再請網通對 netops-syslog 重新 Commit。"
  print_env
}

cmd_sign_csr() {
  need_ca
  CSR="${1:-}"; [ -n "$CSR" ] && [ -f "$CSR" ] || die "用法:sign-csr <PA-560 產生的 CSR 檔>"
  mkwork
  # 先轉成 PEM 放進工作目錄(也接受 DER),之後只處理這份
  openssl req -in "$CSR" -out "$WORK/pa.csr" 2>/dev/null || openssl req -inform DER -in "$CSR" -out "$WORK/pa.csr" 2>/dev/null \
    || die "$CSR 不是 CSR(PEM 或 DER)"
  openssl req -in "$WORK/pa.csr" -noout -verify >/dev/null 2>&1 || die "CSR 簽章驗證失敗"
  openssl req -in "$WORK/pa.csr" -noout -text > "$WORK/csr.txt"

  # 金鑰:RSA ≥ 2048 或 ECDSA P-256 / P-384
  bits="$(sed -n 's/.*Public-Key: (\([0-9]*\) bit).*/\1/p' "$WORK/csr.txt" | head -n 1)"
  if grep -q 'Public Key Algorithm: rsaEncryption' "$WORK/csr.txt"; then
    [ "${bits:-0}" -ge 2048 ] || die "RSA 金鑰太短(${bits:-?} bit,至少 2048)"
  elif grep -q 'Public Key Algorithm: id-ecPublicKey' "$WORK/csr.txt"; then
    grep -qE 'NIST CURVE: P-(256|384)|ASN1 OID: (prime256v1|secp384r1)' "$WORK/csr.txt" || die "ECDSA 曲線要 P-256 或 P-384"
  else
    die "不支援的金鑰演算法(要 RSA 或 ECDSA)"
  fi

  # SAN:只接受 IP 與 DNS;IP 只能是 PA 管理 IP(不可夾帶接收端 10.10.130.122 等其他 IP),DNS 照 CSR 保留但要人工確認
  raw="$(awk '/X509v3 Subject Alternative Name/ {getline; print; exit}' "$WORK/csr.txt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$raw" ] || die "CSR 沒有 SAN(PA 產生 CSR 時要加 IP $PA_IP)"
  san=""; dns=""; has_ip=0
  OLDIFS="$IFS"; IFS=','
  for e in $raw; do
    e="$(echo "$e" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$e" in
      "IP Address:"*)
        v="${e#IP Address:}"
        [ "$v" = "$PA_IP" ] || { IFS="$OLDIFS"; die "SAN 的 IP 只能是 $PA_IP:$(clean "$v")"; }
        has_ip=1
        san="${san:+$san,}IP:$v" ;;
      DNS:*)
        v="${e#DNS:}"
        echo "$v" | grep -qE '^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$' || { IFS="$OLDIFS"; die "SAN 的 DNS 名稱格式不支援:$(clean "$v")"; }
        dns="${dns:+$dns }$v"
        san="${san:+$san,}DNS:$v" ;;
      *) IFS="$OLDIFS"; die "SAN 只接受 IP 與 DNS:$(clean "$e")" ;;
    esac
  done
  IFS="$OLDIFS"
  [ "$has_ip" = 1 ] || die "CSR 的 SAN 沒有 IP $PA_IP(實際:$(clean "$raw")),不簽發;請網通重產 CSR"

  # 主體 CN 必須是 PA 管理 IP 或 SAN 裡的 DNS 名稱(避免主體和 CA 或其他系統相同)
  cn="$(openssl req -in "$WORK/pa.csr" -noout -subject -nameopt multiline | sed -n 's/^[[:space:]]*commonName[[:space:]]*= //p')"
  ok=0; for n in "$PA_IP" $dns; do [ "$cn" = "$n" ] && ok=1; done
  [ "$ok" = 1 ] || die "CSR 的 Common Name 要是 $PA_IP(或 SAN 的 DNS 名稱):$(clean "$cn")"

  # 確認這份 CSR 來自 PA:和網通由另一個管道提供的 CSR 檔 SHA-256 比對(RUNBOOK-prod.md §4.1 第 3 步)
  echo "CSR 檔 SHA-256:$(sha256sum < "$CSR" | cut -d' ' -f1)"
  echo "CSR 公鑰 SHA-256:$(openssl req -in "$WORK/pa.csr" -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)"
  echo "主體 CN:$(clean "$cn");SAN:$san"
  printf '和網通提供的 SHA-256 相同、SAN 也正確才簽發,輸入 y 繼續:'
  read -r ans || ans=""
  [ "$ans" = y ] || die "未簽發"

  # 擴充欄位由本腳本決定(不沿用 CSR 要求的 basicConstraints / keyUsage 等,避免簽出 CA)
  cat > "$WORK/pa.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
  OUT="$(dirname "$CSR")/$(basename "$CSR" | sed 's/\.\(csr\|pem\|req\|der\)$//').crt"
  [ ! -e "$OUT" ] || die "$OUT 已存在,先移走再執行"
  sign "$WORK/pa.csr" "$WORK/pa.crt" "$WORK/pa.ext" "$san"
  install -m 644 "$WORK/pa.crt" "$OUT"
  echo "已簽發 PA-560 管理介面憑證:$OUT"
  echo "  主體:$(openssl x509 -in "$OUT" -noout -subject | sed 's/^subject=//')"
  echo "  SAN:$san"
  echo "  到期:$(enddate "$OUT")"
  echo "  SHA-256 指紋:$(fp "$OUT")"
  echo "交給網通匯入 PA(Device > Certificates,選產生 CSR 的同名憑證 Import),再設為管理介面的 SSL/TLS Service Profile。"
  echo "netops.env 要有 PA_CA_FILE=/run/pa-tls/pa-mgmt-ca.pem、PA_HOST=$PA_IP(server 子指令印的設定)。"
}

cmd_status() {
  need_ca
  printf '%-14s %s | 到期 %s\n' "CA" "$(openssl x509 -in "$CA_DIR/ca.crt" -noout -subject | sed 's/^subject=//')" "$(enddate "$CA_DIR/ca.crt")"
  if [ -f "$TLS_DIR/server.crt" ]; then
    printf '%-14s %s | 到期 %s\n' "server.crt" "$(openssl x509 -in "$TLS_DIR/server.crt" -noout -ext subjectAltName 2>/dev/null | tail -n 1 | sed 's/^[[:space:]]*//')" "$(enddate "$TLS_DIR/server.crt")"
  else
    echo "server.crt     (尚未簽發)"
  fi
  echo "已簽發(UTC 時間、序號、到期、主體、SAN):"
  cat "$CA_DIR/issued.txt" 2>/dev/null || echo "  (無)"
  ls -l "$TLS_DIR" 2>/dev/null || true
}

case "${1:-}" in
  init) cmd_init ;;
  server) shift; cmd_server "$@" ;;
  sign-csr) shift; cmd_sign_csr "$@" ;;
  status) cmd_status ;;
  *) usage ;;
esac
