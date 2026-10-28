# Ask My Notes: API + built UI in one image. Postgres (with pgvector) runs separately.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY . .
RUN npm --prefix web run build

ENV PORT=8787 NOTES_DIR=/notes
EXPOSE 8787
# Index the mounted notes (incremental, so restarts are cheap), then serve.
CMD ["sh", "-c", "npm run ingest && npm start"]
