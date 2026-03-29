FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV VISTA_DATA_DIR=/data

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/backend/requirements.txt \
    && mkdir -p /data

COPY backend /app/backend
COPY uzbekistan_gabon_synthetic_dataset_package /app/uzbekistan_gabon_synthetic_dataset_package
COPY event_log_detailed_full_match.csv /app/event_log_detailed_full_match.csv
COPY shot_map_detailed_coordinates.csv /app/shot_map_detailed_coordinates.csv

EXPOSE 8000

CMD ["sh", "-c", "uvicorn api:app --app-dir /app/backend --host 0.0.0.0 --port ${PORT:-8000}"]
