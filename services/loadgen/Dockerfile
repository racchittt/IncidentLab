FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY services/runtime ./services/runtime
COPY services/loadgen ./services/loadgen
RUN npm install
WORKDIR /app/services/loadgen
CMD ["npx", "tsx", "index.ts"]
