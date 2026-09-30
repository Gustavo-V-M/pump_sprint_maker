FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    DATA_DIR=/app/data \
    PIU_SCORES_URL=https://piuscores.arroweclip.se

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py piu_api.py store.py ./
COPY templates/ templates/
COPY static/ static/

RUN mkdir -p /app/data

EXPOSE 8000

# PIU_SCORES_TOKEN must be supplied at runtime (docker run -e / compose env), never baked in.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT} --workers 2 --threads 4 app:app"]