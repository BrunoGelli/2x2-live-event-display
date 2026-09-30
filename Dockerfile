FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LIVE2X2_CACHE=/cache
WORKDIR /app
COPY pyproject.toml README.md /app/
COPY src /app/src
# Web-only installation. The image never installs the analysis/worker dependency.
RUN pip install --no-cache-dir . && live2x2 assets
USER 10001:10001
EXPOSE 8000
CMD ["live2x2", "serve", "--cache", "/cache", "--host", "0.0.0.0", "--port", "8000"]
