# netops-pa(NetOps R1,docs/PA-LIVE-PLAN.md §3.1):Python 3.12 + pan-os-python
#   docker build --pull --target test .   CI check:ruff + pytest(假 PA、fakeredis;不連任何外部主機)
#   docker build --pull .                 執行映像(非 root、不含測試相依)
# 映像在主機 2 建置;主機 3 只拉 Registry 映像(AGENT.md §6)
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM base AS test
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY pyproject.toml ./
COPY netops_pa ./netops_pa
COPY tests ./tests
RUN ruff check . && python -m pytest

FROM base AS runtime
COPY netops_pa ./netops_pa
# uid 1000:與 netops-api 相同,讀得到主機機密檔(deploy/host*-set-pa-secrets.sh 設 1000:1000 / 400)
RUN useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin netops
USER 1000
EXPOSE 51293 51294
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-m", "netops_pa", "health"]
CMD ["python", "-m", "netops_pa"]
