FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY services/runtime ./services/runtime
COPY services/worker-service ./services/worker-service
RUN npm install
WORKDIR /app/services/worker-service
CMD ["npx", "tsx", "index.ts"]
