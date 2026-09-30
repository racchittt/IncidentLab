FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY services/runtime ./services/runtime
COPY services/sqs-exporter ./services/sqs-exporter
RUN npm install
WORKDIR /app/services/sqs-exporter
CMD ["npx", "tsx", "index.ts"]
