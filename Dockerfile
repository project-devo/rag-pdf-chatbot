# Dockerfile for the RAG PDF Chatbot
# Works on Hugging Face Spaces (Docker SDK), Render, Railway, Fly.io, or any Docker host.

FROM python:3.11-slim

# System deps needed by chromadb
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Pre-download the embedding model at build time so the first request
# isn't slow and so it works even if the container has restricted
# internet access at runtime.
RUN python -c "from chromadb.utils.embedding_functions import DefaultEmbeddingFunction; DefaultEmbeddingFunction()(['warmup'])"

# Hugging Face Spaces expects the app to listen on port 7860.
# Other hosts (Render, Railway, Fly.io) usually inject $PORT - we fall back to 7860.
ENV PORT=7860
EXPOSE 7860

# Persist the Chroma DB inside the container's writable layer.
# On HF Spaces, mount a Persistent Storage volume at /app/chroma_db to survive restarts.
ENV CHROMA_DIR=/app/chroma_db

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
