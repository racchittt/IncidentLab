import express, { Request, Response, Application } from "express";

const app: Application = express();
const PORT: number = 3001;

interface OrderParams {
  id: string;
}

interface OrderResponse {
  orderId: string;
  status: string;
}

import { latencyFaultMiddleware, setLatencyFault } from "./faults/latency";

app.use(express.json());
app.use(latencyFaultMiddleware);

app.get(
  "/orders/:id",
  (req: Request<OrderParams>, res: Response<OrderResponse>) => {
    const { id } = req.params;
    res.json({ orderId: id, status: "created" });
  }
);

app.post("/admin/inject-fault", (req: Request, res: Response) => {
  const delayMs = req.body?.delayMs;
  if (typeof delayMs !== "number" || delayMs < 0) {
    return res.status(400).json({ error: "delayMs must be a non-negative number" });
  }
  setLatencyFault(delayMs);
  res.sendStatus(200);
});

app.post("/admin/reset-fault", (req: Request, res: Response) => {
  setLatencyFault(null);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`order-service on ${PORT}`));
