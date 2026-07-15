# RAG PDF Chatbot

A full Retrieval-Augmented Generation (RAG) chatbot that answers questions about any PDF you upload.

## How it works

1. **Upload** a PDF via the web UI or `/upload` API.
2. **Extract & chunk**: text is pulled page-by-page (`pypdf`) and split into ~400-token overlapping chunks so context isn't cut mid-thought.
3. **Embed & store**: each chunk is embedded locally with `sentence-transformers` (`all-MiniLM-L6-v2`, free, no API calls) and stored in a persistent **Chroma** vector database, one collection per document (keyed by a content hash, so re-uploading the same file skips re-indexing).
4. **Retrieve**: your question is embedded and compared against stored chunks to find the top-5 most relevant excerpts.
5. **Generate**: those excerpts + your question + conversation history are sent to a free **Groq**-hosted LLM (Llama 3.3 70B by default), which is instructed to answer *only* from the provided context and to cite page numbers.

This means the **entire stack runs for free**: local embeddings, local vector DB, and a free-tier LLM API.

## Project structure

```
rag_pdf_chatbot/
├── app.py              # FastAPI server (routes: /, /upload, /chat)
├── rag.py              # Core RAG pipeline (ingest, retrieve, generate)
├── static/index.html   # Minimal chat UI (vanilla JS, no build step)
├── requirements.txt
└── README.md
```

## Setup

```bash
cd rag_pdf_chatbot
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Set your Groq API key (free — no credit card required):

```bash
export GROQ_API_KEY=gsk_...     # Windows: set GROQ_API_KEY=gsk_...
```

Get a free key at https://console.groq.com/keys

## Run

```bash
python app.py
```

Then open **http://localhost:8000** in your browser. Upload a PDF and start asking questions.

## API usage (without the UI)

**Upload:**
```bash
curl -X POST http://localhost:8000/upload -F "file=@/path/to/your.pdf"
# -> {"doc_id": "doc_ab12cd34...", "filename": "your.pdf", "num_chunks": 42, "num_pages": 10, "status": "ingested"}
```

**Ask a question:**
```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"doc_id": "doc_ab12cd34...", "question": "What is the main conclusion of this document?"}'
```

## Configuration (environment variables)

| Variable        | Default                     | Purpose                                  |
|-----------------|------------------------------|-------------------------------------------|
| `GROQ_API_KEY`  | (required)                   | Your free Groq API key                    |
| `GROQ_MODEL`    | `llama-3.3-70b-versatile`    | Chat model used for generation            |
| `EMBED_MODEL`   | `all-MiniLM-L6-v2`            | Sentence-transformers embedding model     |
| `CHROMA_DIR`    | `./chroma_db`                | Where the vector DB is persisted on disk  |
| `PORT`          | `8000` (local) / `7860` (Docker) | Server port                          |

## Deploying for free (Hugging Face Spaces)

This repo includes a `Dockerfile` and HF Spaces metadata, so deployment is copy-paste simple.

1. **Create a Space**: go to https://huggingface.co/new-space, choose **Docker** as the SDK, pick any name, set visibility to public or private.
2. **Push this code** to the Space's git repo:
   ```bash
   git init
   git remote add space https://huggingface.co/spaces/<your-username>/<your-space-name>
   git add .
   git commit -m "Initial commit"
   git push space main
   ```
   (Rename `README_HF.md` to `README.md` first, or merge its front-matter block into your existing README — HF Spaces reads the YAML front matter at the top of `README.md` to configure the Space.)
3. **Add your secret**: in the Space's **Settings → Repository secrets**, add `GROQ_API_KEY` with your key. Never commit it to the repo.
4. **(Optional) Persistent storage**: by default, anything written inside the container (like the Chroma DB) is wiped on restart/rebuild. In **Settings → Storage**, you can attach a small persistent volume and mount it at `/app/chroma_db` so uploaded PDFs stay indexed across restarts. Without it, users just need to re-upload PDFs after a Space restart.
5. Build takes a few minutes (installing `sentence-transformers` + downloading the embedding model). Once done, your chatbot is live at `https://<your-username>-<your-space-name>.hf.space`.

### Other free hosts

The same `Dockerfile` works on:
- **Render** — free web service tier (sleeps after ~15 min idle, cold start ~30s on next request)
- **Railway** — small free monthly credit, no sleep on paid-tier-adjacent plans
- **Fly.io** — free allowance for small single-container apps (`fly launch` picks up the Dockerfile automatically)

For all of these: set `GROQ_API_KEY` as an environment variable/secret in the host's dashboard, and (if offered) attach a persistent volume for `CHROMA_DIR` so indexed PDFs survive restarts.

## Extending this project

- **Multi-file chat**: pass multiple `doc_id`s to `/chat` and merge retrieval results across collections.
- **Better chunking**: swap the token-window chunker in `rag.py` for a semantic/recursive splitter (e.g. LangChain's `RecursiveCharacterTextSplitter`) if you need smarter boundaries.
- **OCR support**: scanned PDFs return no extractable text — pipe them through `pytesseract` or `ocrmypdf` before ingestion.
- **Streaming responses**: use `client.messages.stream(...)` in `rag.py` and a Server-Sent-Events endpoint for a typing effect in the UI.
- **Auth & multi-user**: add a user_id namespace to collection names and gate `/upload`/`/chat` behind an auth middleware.
- **Swap vector DB**: Chroma is used here for zero-config local persistence; for production scale, swap in Pinecone, Qdrant, or pgvector with minimal changes to `rag.py`.

## Notes

- The embedding model runs **locally** (no API cost, no data leaves your machine for embeddings) — only the final question + retrieved excerpts are sent to Claude.
- Chroma persists to disk (`CHROMA_DIR`), so uploaded documents remain indexed across server restarts.
- This is a reference implementation optimized for clarity; for production use, add file size limits, rate limiting, and structured logging.
