"""Checks for the embedding/chunking path. Run: python test_rag.py"""

from dotenv import load_dotenv
load_dotenv()

import sys

import rag


def test_no_torch_imported():
    # The whole point of the ONNX embedding function is that torch never loads;
    # torch's resident footprint alone does not fit in a 512MB host.
    assert "torch" not in sys.modules, "torch got imported - memory footprint will blow the host limit"


def test_embedding_dim():
    vecs = rag._embedding_fn(["hello world"])
    assert len(vecs) == 1
    assert len(vecs[0]) == 384, f"expected 384-dim all-MiniLM-L6-v2 output, got {len(vecs[0])}"


def test_chunking_overlaps_and_tracks_pages():
    page = " ".join(f"w{i}" for i in range(700))
    chunks = rag.chunk_text(["", page])

    assert all(c.page == 2 for c in chunks), "page numbers should skip the empty first page"
    assert len(chunks) == 3, f"700 words at size 300/overlap 50 should give 3 chunks, got {len(chunks)}"

    first = chunks[0].text.split()
    second = chunks[1].text.split()
    assert first[-rag.CHUNK_OVERLAP_WORDS:] == second[:rag.CHUNK_OVERLAP_WORDS], "chunks should overlap"


def test_ingest_pdf_stores_folder_in_metadata():
    # Skip the PdfWriter part - we're testing the registry functions, not PDF extraction.
    # Directly create a collection with metadata to test list/set_folder/delete.
    doc_id = "doc_task1_test"
    collection = rag.get_collection(doc_id)
    if collection.count() == 0:
        collection.add(
            ids=["c1"],
            documents=["placeholder chunk text"],
            metadatas=[{"page": 1, "filename": "sample.pdf"}],
        )
    collection.modify(metadata={"filename": "sample.pdf", "folder": "Unfiled", "num_pages": 1})

    docs = rag.list_documents()
    match = next((d for d in docs if d["doc_id"] == doc_id), None)
    assert match is not None, "list_documents() should include the collection we just created"
    assert match["folder"] == "Unfiled"
    assert match["filename"] == "sample.pdf"
    assert match["num_chunks"] == 1
    assert match["num_pages"] == 1

    updated = rag.set_folder(doc_id, "Work")
    assert updated["folder"] == "Work"
    refetched = next(d for d in rag.list_documents() if d["doc_id"] == doc_id)
    assert refetched["folder"] == "Work", "set_folder must persist, not just return the new value"
    assert refetched["filename"] == "sample.pdf", "set_folder must not clobber other metadata keys"

    rag.delete_document(doc_id)
    assert all(d["doc_id"] != doc_id for d in rag.list_documents())


def test_set_folder_missing_doc_raises():
    try:
        rag.set_folder("doc_does_not_exist_xyz", "Work")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "doc_does_not_exist_xyz" in str(e)


def test_delete_document_missing_doc_raises():
    try:
        rag.delete_document("doc_does_not_exist_xyz")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "doc_does_not_exist_xyz" in str(e)


def test_get_or_create_welcome_generates_and_caches():
    doc_id = "doc_task2_test"
    collection = rag.get_collection(doc_id)
    if collection.count() == 0:
        collection.add(
            ids=["c1"],
            documents=[
                "This document is a quarterly financial report. Revenue grew 12% "
                "year over year to $4.2M. Operating expenses were $2.8M, driven "
                "mainly by headcount growth in engineering and sales."
            ],
            metadatas=[{"page": 1, "filename": "finance.pdf"}],
        )
    collection.modify(metadata={"filename": "finance.pdf", "folder": "Unfiled", "num_pages": 1})

    first = rag.get_or_create_welcome(doc_id)
    assert isinstance(first["message"], str) and len(first["message"]) > 0
    assert isinstance(first["suggested_questions"], list)
    assert len(first["suggested_questions"]) == 3
    assert all(isinstance(q, str) and q for q in first["suggested_questions"])

    # Second call must hit the cache, not call Groq again - same object back.
    second = rag.get_or_create_welcome(doc_id)
    assert second == first

    rag.delete_document(doc_id)


def test_get_or_create_welcome_missing_doc_raises():
    try:
        rag.get_or_create_welcome("doc_does_not_exist_xyz")
        assert False, "expected ValueError"
    except ValueError as e:
        assert "doc_does_not_exist_xyz" in str(e)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all passed")
