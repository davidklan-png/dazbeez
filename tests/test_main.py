"""
Tests for Dazbeez homepage.
Run: docker exec <container> python -m pytest tests/ -v
"""
from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "timestamp" in data


def test_homepage():
    response = client.get("/")
    assert response.status_code == 200
    assert "Dazbeez" in response.text


def test_openapi():
    response = client.get("/openapi.json")
    assert response.status_code == 200
