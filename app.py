"""
FastAPI backend for the RAG PDF Chatbot.

Endpoints:
  POST /upload          -> upload a PDF, ingest it, returns doc_id
  POST /chat             -> ask a question about a previously uploaded doc_id
  GET  /                 -> serves the static chat UI
"""

import os
import shutil
import tempfile
from typing import List, Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import rag

app = FastAPI(title="RAG PDF Chatbot")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        result = rag.ingest_pdf(tmp_path, original_filename=file.filename)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        os.unlink(tmp_path)

    return result


class ChatTurn(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    doc_id: str
    question: str
    history: Optional[List[ChatTurn]] = None


@app.post("/chat")
def chat(req: ChatRequest):
    history = [{"role": t.role, "content": t.content} for t in (req.history or [])]
    try:
        result = rag.answer_question(req.doc_id, req.question, history)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
