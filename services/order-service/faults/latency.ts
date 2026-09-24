import { Request, Response, NextFunction } from "express";

let activeDelayMs: number | null = null;

export function setLatencyFault(delayMs: number | null) {
  activeDelayMs = delayMs;
}

export function latencyFaultMiddleware(req: Request, res: Response, next: NextFunction) {
  if (activeDelayMs !== null) {
    setTimeout(next, activeDelayMs);
  } else {
    next();
  }
}