FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY services/runtime ./services/runtime
COPY services/deploy-registry ./services/deploy-registry
RUN npm install
WORKDIR /app/services/deploy-registry
CMD ["npx", "tsx", "index.ts"]
