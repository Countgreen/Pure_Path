from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes import router   # ✅ fixed import

app = FastAPI(title="PurePath API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
