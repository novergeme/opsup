FROM node:20-alpine

WORKDIR /app

# Install native deps for jsdom
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p /app/documents

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8081/health || exit 1

CMD ["node", "server.js"]
