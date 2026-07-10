FROM sweb.env.py.x86_64.24cb673f3ac171ac835366:latest

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH=/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
        'httpx<0.28' \
        'django<5' \
        'djangorestframework<3.16' \
        'hypothesis<7' \
        'fastapi<0.100' \
        'pytest-mock<4' \
        'pytest-asyncio<0.24' \
        'freezegun<2' \
        'PyJWT<3' \
        'passlib<2' \
        'fakeredis<3' \
        'rx<4' \
        'duckdb<2' \
        'python-dotenv<2'
