import express from "express";
import { prisma } from "../lib/db";
import { requireAuth } from "./middleware";

export const router = express.Router();

// PLANTED: AUTH002 - authenticated, but loads any user's invoice by id
router.get("/invoices/:id", requireAuth, async (req: any, res: any) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  res.json(invoice);
});

// PLANTED: AUTH001 - no auth middleware, writes data
router.post("/posts", async (req: any, res: any) => {
  const post = await prisma.post.create({
    data: { title: String(req.body.title), slug: String(req.body.slug), authorId: String(req.body.authorId) },
  });
  res.status(201).json(post);
});

// SAFE: authenticated and scoped. Expected: no findings.
router.get("/my/invoices", requireAuth, async (req: any, res: any) => {
  const invoices = await prisma.invoice.findMany({ where: { userId: req.user.id } });
  res.json(invoices);
});
