FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend-src
COPY frontend-src/package*.json ./
RUN npm ci
COPY frontend-src ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY --from=frontend-builder /app/frontend ./frontend

RUN mkdir -p /app/documents

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8081/health || exit 1

CMD ["node", "server.js"]
