with open('backend/main.py', 'a') as f:
    f.write('\n\nif __name__ == "__main__":\n    import uvicorn\n    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))\n')
