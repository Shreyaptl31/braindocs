from fastapi import FastAPI, UploadFile, File, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import tempfile, os, shutil, uuid
from datetime import datetime, timedelta
from typing import Optional

from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_qdrant import QdrantVectorStore
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="RAG API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

client = OpenAI()
embedding_model = OpenAIEmbeddings(model="text-embedding-3-large")

QDRANT_URL    = os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
MAX_MESSAGES  = 5

sessions: dict = {}


def get_or_create_session(session_id: Optional[str]) -> str:
    now = datetime.utcnow()
    expired = [sid for sid, s in sessions.items() if now - s["created_at"] > timedelta(hours=24)]
    for sid in expired:
        del sessions[sid]

    if not session_id or session_id not in sessions:
        session_id = str(uuid.uuid4())
        sessions[session_id] = {"count": 0, "created_at": now}

    return session_id


class QueryRequest(BaseModel):
    query: str
    collection_name: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/session")
def create_session():
    sid = str(uuid.uuid4())
    sessions[sid] = {"count": 0, "created_at": datetime.utcnow()}
    return {"session_id": sid, "messages_left": MAX_MESSAGES}


@app.get("/session/{session_id}")
def get_session(session_id: str):
    if session_id not in sessions:
        raise HTTPException(404, "Session not found")
    used = sessions[session_id]["count"]
    return {
        "session_id": session_id,
        "messages_used": used,
        "messages_left": max(0, MAX_MESSAGES - used),
        "limit": MAX_MESSAGES,
    }


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(400, "Only PDF files allowed")

    collection_name = file.filename.replace(".pdf", "").replace(" ", "_").lower()

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        loader = PyPDFLoader(file_path=tmp_path)
        docs = loader.load()

        splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=400)
        split_docs = splitter.split_documents(docs)

        for doc in split_docs:
            doc.metadata["source"] = file.filename

        QdrantVectorStore.from_documents(
            documents=split_docs,
            url=QDRANT_URL,
            api_key=QDRANT_API_KEY,
            collection_name=collection_name,
            embedding=embedding_model,
        )

        return {
            "collection_name": collection_name,
            "filename": file.filename,
            "chunks": len(split_docs),
            "pages": len(docs),
        }
    finally:
        os.unlink(tmp_path)


@app.post("/query")
async def query(req: QueryRequest, x_session_id: Optional[str] = Header(None)):
    session_id = get_or_create_session(x_session_id)
    session = sessions[session_id]

    if session["count"] >= MAX_MESSAGES:
        raise HTTPException(429, f"Message limit reached. You can only send {MAX_MESSAGES} messages per session.")

    try:
        vector_db = QdrantVectorStore.from_existing_collection(
            url=QDRANT_URL,
            api_key=QDRANT_API_KEY,
            collection_name=req.collection_name,
            embedding=embedding_model,
        )
    except Exception:
        raise HTTPException(404, "Collection not found. Please upload a PDF first.")

    results = vector_db.similarity_search(query=req.query, k=4)

    sources = [
        {
            "content": r.page_content,
            "page": r.metadata.get("page_label", r.metadata.get("page", "?")),
            "source": r.metadata.get("source", ""),
        }
        for r in results
    ]

    context = "\n\n".join(
        [f"Page Content: {s['content']}\nPage Number: {s['page']}\nFile: {s['source']}" for s in sources]
    )

    system_prompt = f"""You are a helpful AI Assistant who answers user queries based on the available context retrieved from a PDF file along with page contents and page numbers.
Answer only based on the following context and navigate the user to the right page number to know more.

Context:
{context}"""

    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": req.query},
        ],
    )

    session["count"] += 1
    messages_left = MAX_MESSAGES - session["count"]

    return {
        "answer": completion.choices[0].message.content,
        "sources": sources,
        "session_id": session_id,
        "messages_left": messages_left,
        "messages_used": session["count"],
    }