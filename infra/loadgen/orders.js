import http from "k6/http";

export const options = {
  scenarios: {
    constant_orders: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "24h",
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
};

export default function () {
  http.post(
    "http://nginx/orders",
    JSON.stringify({ item: "loadgen" }),
    { headers: { "Content-Type": "application/json" } }
  );
}
