FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY services/runtime ./services/runtime
COPY services/order-service ./services/order-service
RUN npm install
WORKDIR /app/services/order-service
CMD ["npx", "tsx", "index.ts"]
