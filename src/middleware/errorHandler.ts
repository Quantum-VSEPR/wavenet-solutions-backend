import { Request, Response, NextFunction } from "express";

interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export const errorHandler = (
  err: AppError,
  _req: Request, // Prefixed req with _
  res: Response,
  _next: NextFunction // Prefixed next with _
): void => {
  err.statusCode = err.statusCode || 500;
  err.message = err.message || "Internal Server Error";

  // Log the error for debugging (consider using a dedicated logger)
  console.error("ERROR 💥", err);

  // Operational, trusted error: send message to client
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: "error",
      message: err.message,
    });
  } else {
    // Programming or other unknown error: don't leak error details
    res.status(500).json({
      status: "error",
      message: "Something went very wrong!",
    });
  }
};
