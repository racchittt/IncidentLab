FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY services/runtime ./services/runtime
COPY services/mock-payment-provider ./services/mock-payment-provider
RUN npm install
WORKDIR /app/services/mock-payment-provider
CMD ["npx", "tsx", "index.ts"]
