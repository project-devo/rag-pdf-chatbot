"""
Core RAG (Retrieval-Augmented Generation) engine for the PDF chatbot.

Pipeline:
  1. Extract text from PDF (pypdf)
  2. Chunk text with overlap (token-aware, using tiktoken as a length proxy)
  3. Embed chunks (all-MiniLM-L6-v2 via onnxruntime, local, no API cost)
  4. Store in a persistent Chroma vector DB (per-document collection)
  5. On query: embed the query, retrieve top-k similar chunks
  6. Build a grounded prompt and call Claude to answer using only that context
"""

import json
import os
import uuid
import hashlib
from dataclasses import dataclass
from typing import List, Dict, Optional

import chromadb
from chromadb.utils import embedding_functions
from pypdf import PdfReader
from groq import Groq

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CHROMA_DIR = os.environ.get("CHROMA_DIR", "./chroma_db")
CHAT_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
CHUNK_SIZE_WORDS = 300
CHUNK_OVERLAP_WORDS = 50
TOP_K = 5

_client = chromadb.PersistentClient(path=CHROMA_DIR)

# all-MiniLM-L6-v2 via onnxruntime rather than sentence-transformers: same model
# and same 384-dim output, but avoids pulling in torch (~400MB resident, which
# does not fit in a 512MB host).
_embedding_fn = embedding_functions.DefaultEmbeddingFunction()

_groq_client: Optional[Groq] = None


def get_groq_client() -> Groq:
    global _groq_client
    if _groq_client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY environment variable is not set. "
                "Get a free key from https://console.groq.com/keys and export it."
            )
        _groq_client = Groq(api_key=api_key)
    return _groq_client


@dataclass
class Chunk:
    id: str
    text: str
    page: int


# ---------------------------------------------------------------------------
# PDF extraction + chunking
# ---------------------------------------------------------------------------

def extract_pages(pdf_path: str) -> List[str]:
    """Return a list of page texts (index = page number - 1)."""
    reader = PdfReader(pdf_path)
    return [page.extract_text() or "" for page in reader.pages]


def chunk_text(pages: List[str]) -> List[Chunk]:
    """
    Chunk page texts into overlapping windows of words,
    tracking which page each chunk came from.
    """
    chunks: List[Chunk] = []
    for page_num, page_text in enumerate(pages, start=1):
        if not page_text.strip():
            continue
        words = page_text.split()
        start = 0
        while start < len(words):
            end = min(start + CHUNK_SIZE_WORDS, len(words))
            chunk_str = " ".join(words[start:end])
            chunks.append(
                Chunk(id=str(uuid.uuid4()), text=chunk_str, page=page_num)
            )
            if end == len(words):
                break
            start = end - CHUNK_OVERLAP_WORDS
    return chunks


# ---------------------------------------------------------------------------
# Vector store
# ---------------------------------------------------------------------------

def doc_id_for_file(pdf_path: str) -> str:
    """Stable collection name derived from file content hash."""
    h = hashlib.sha256()
    with open(pdf_path, "rb") as f:
        for block in iter(lambda: f.read(8192), b""):
            h.update(block)
    return "doc_" + h.hexdigest()[:16]


def get_collection(doc_id: str):
    return _client.get_or_create_collection(
        name=doc_id, embedding_function=_embedding_fn
    )


def list_documents() -> List[Dict]:
    """List every ingested document with its folder and stats."""
    docs = []
    for col in _client.list_collections():
        meta = col.metadata or {}
        docs.append({
            "doc_id": col.name,
            "filename": meta.get("filename", col.name),
            "folder": meta.get("folder", "Unfiled"),
            "num_chunks": col.count(),
            "num_pages": meta.get("num_pages"),
        })
    return docs


def set_folder(doc_id: str, folder: str) -> Dict:
    """Move a document to a different folder. Metadata is replace-on-write,
    so we read-merge-write the full dict rather than passing {"folder": folder}."""
    try:
        collection = _client.get_collection(name=doc_id, embedding_function=_embedding_fn)
    except Exception as e:
        raise ValueError(f"Document {doc_id} not found") from e

    meta = dict(collection.metadata or {})
    meta["folder"] = folder
    collection.modify(metadata=meta)

    return {
        "doc_id": doc_id,
        "filename": meta.get("filename", doc_id),
        "folder": folder,
        "num_chunks": collection.count(),
        "num_pages": meta.get("num_pages"),
    }


def delete_document(doc_id: str) -> None:
    try:
        _client.get_collection(name=doc_id, embedding_function=_embedding_fn)
    except Exception as e:
        raise ValueError(f"Document {doc_id} not found") from e
    _client.delete_collection(doc_id)


WELCOME_SYSTEM_PROMPT = """You summarize documents for a chat app's welcome screen.
Given excerpts from a document, respond with a JSON object of this exact shape:
{"summary": "<1-2 sentence plain-English summary of what the document is about>", "questions": ["q1", "q2", "q3"]}
"questions" is exactly three example questions a user could ask about the document. Example:
{"summary": "This is a Q1 2026 financial report covering revenue, expenses, and headcount growth.", "questions": ["What was total revenue this quarter?", "Why did operating expenses increase?", "How much did headcount grow?"]}"""


def get_or_create_welcome(doc_id: str) -> Dict:
    try:
        collection = _client.get_collection(name=doc_id, embedding_function=_embedding_fn)
    except Exception as e:
        raise ValueError(f"Document {doc_id} not found") from e

    meta = dict(collection.metadata or {})
    if meta.get("welcome_message") and meta.get("welcome_questions"):
        return {
            "message": meta["welcome_message"],
            "suggested_questions": json.loads(meta["welcome_questions"]),
        }

    sample = collection.get(limit=3)
    excerpt = "\n\n".join(sample.get("documents", []))[:3000]

    fallback = {
        "message": f"Document {meta.get('filename', doc_id)} has been loaded. What would you like to know about it?",
        "suggested_questions": [],
    }
    if not excerpt.strip():
        return fallback

    try:
        client = get_groq_client()
        response = client.chat.completions.create(
            model=CHAT_MODEL,
            max_tokens=300,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": WELCOME_SYSTEM_PROMPT},
                {"role": "user", "content": f"Document excerpts:\n---\n{excerpt}\n---"},
            ],
        )
        data = json.loads(response.choices[0].message.content)
        message = data.get("summary")
        questions = data.get("questions")
        if not (isinstance(message, str) and message.strip()):
            return fallback
        if not (
            isinstance(questions, list)
            and len(questions) == 3
            and all(isinstance(q, str) and q.strip() for q in questions)
        ):
            return fallback
    except Exception:
        return fallback

    meta["welcome_message"] = message
    meta["welcome_questions"] = json.dumps(questions)
    collection.modify(metadata=meta)

    return {"message": message, "suggested_questions": questions}


def ingest_pdf(pdf_path: str, original_filename: str, folder: str = "Unfiled") -> Dict:
    """
    Ingest a PDF: extract, chunk, embed, and store.
    Idempotent - if the doc was already ingested (same content hash), skip re-embedding.
    Returns metadata about the ingested document.
    """
    doc_id = doc_id_for_file(pdf_path)
    collection = get_collection(doc_id)

    if collection.count() > 0:
        meta = collection.metadata or {}
        return {
            "doc_id": doc_id,
            "filename": meta.get("filename", original_filename),
            "folder": meta.get("folder", "Unfiled"),
            "num_chunks": collection.count(),
            "num_pages": meta.get("num_pages"),
            "status": "already_ingested",
        }

    pages = extract_pages(pdf_path)
    chunks = chunk_text(pages)

    if not chunks:
        raise ValueError(
            "No extractable text found in this PDF. It may be scanned/image-only; "
            "consider OCR-ing it first."
        )

    collection.add(
        ids=[c.id for c in chunks],
        documents=[c.text for c in chunks],
        metadatas=[{"page": c.page, "filename": original_filename} for c in chunks],
    )
    collection.modify(metadata={
        "filename": original_filename,
        "folder": folder,
        "num_pages": len(pages),
    })

    return {
        "doc_id": doc_id,
        "filename": original_filename,
        "folder": folder,
        "num_chunks": len(chunks),
        "num_pages": len(pages),
        "status": "ingested",
    }


def retrieve(doc_id: str, query: str, top_k: int = TOP_K) -> List[Dict]:
    collection = get_collection(doc_id)
    results = collection.query(query_texts=[query], n_results=top_k)

    hits = []
    docs = results.get("documents", [[]])[0]
    metas = results.get("metadatas", [[]])[0]
    dists = results.get("distances", [[]])[0]
    for text, meta, dist in zip(docs, metas, dists):
        hits.append({"text": text, "page": meta.get("page"), "score": dist})
    return hits


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful assistant answering questions about a specific PDF document.
Answer ONLY using the provided context excerpts. If the answer is not contained in the
context, say clearly that the document doesn't seem to cover that, rather than guessing.
When useful, mention which page(s) the information came from (e.g. "(p. 4)").
Be concise and directly answer the question first, then add supporting detail."""


def build_prompt(query: str, hits: List[Dict], history: List[Dict]) -> List[Dict]:
    context_block = "\n\n".join(
        f"[Excerpt from page {h['page']}]\n{h['text']}" for h in hits
    )

    user_turn = f"""Context excerpts from the document:
---
{context_block}
---

Question: {query}"""

    messages = list(history) + [{"role": "user", "content": user_turn}]
    return messages


def answer_question(
    doc_id: str, query: str, history: Optional[List[Dict]] = None
) -> Dict:
    history = history or []
    hits = retrieve(doc_id, query)

    if not hits:
        return {
            "answer": "I couldn't find relevant content in the document for that question.",
            "sources": [],
        }

    messages = build_prompt(query, hits, history)
    client = get_groq_client()

    # Groq uses the OpenAI-style chat completions format: system prompt goes
    # in the messages array as its own message, not a separate parameter.
    full_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    response = client.chat.completions.create(
        model=CHAT_MODEL,
        max_tokens=1024,
        messages=full_messages,
    )

    answer_text = response.choices[0].message.content

    sources = [{"page": h["page"], "snippet": h["text"][:200]} for h in hits]
    return {"answer": answer_text, "sources": sources}
