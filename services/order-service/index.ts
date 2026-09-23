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

app.get(
  "/orders/:id",
  (req: Request<OrderParams>, res: Response<OrderResponse>) => {
    const { id } = req.params;
    res.json({ orderId: id, status: "created" });
  }
);

app.listen(PORT, () => console.log(`order-service on ${PORT}`));
