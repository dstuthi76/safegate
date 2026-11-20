import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ids, scan } from "./helpers";

const NO_PRISMA = { "prisma/schema.prisma": "" };

const at = (findings: { ruleId: string; line: number; file: string }[]) => findings.map((f) => `${f.ruleId}:${f.file.split("/").pop()}:${f.line}`).sort();

test("TypeORM: entity owner via @ManyToOne, repository IDOR, scoped query, mass assignment", () => {
  const f = scan({
    ...NO_PRISMA,
    "src/entity/Post.ts": `import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "typeorm";
@Entity("posts")
export class Post {
  @PrimaryGeneratedColumn() id: number;
  @Column() title: string;
  @Column({ default: false }) isAdmin: boolean;
  @ManyToOne(() => User, (u) => u.posts) author: User;
}`,
    "src/routes.ts": `import express from "express";
const app = express();
const postRepository = AppDataSource.getRepository(Post);
app.get("/posts/:id", requireAuth, async (req, res) => {
  const post = await postRepository.findOneBy({ id: Number(req.params.id) });
  res.json(post);
});
app.get("/mine/:id", requireAuth, async (req, res) => {
  const post = await postRepository.findOne({ where: { id: Number(req.params.id), author: { id: req.user.id } } });
  res.json(post);
});
app.delete("/posts/:id", requireAuth, async (req, res) => {
  await AppDataSource.getRepository(Post).delete(req.params.id);
  res.sendStatus(204);
});
app.post("/posts", requireAuth, async (req, res) => {
  res.json(await postRepository.save({ ...req.body }));
});
`
  });
  assert.deepEqual(at(f), ["AUTH002:routes.ts:5", "AUTH003:routes.ts:13", "AUTH004:routes.ts:17"]);
});

test("TypeORM: owner check after load counts; EntityManager with entity argument", () => {
  const f = scan({
    ...NO_PRISMA,
    "src/entity/Doc.ts": `import { Entity, Column, PrimaryColumn } from "typeorm";
@Entity() export class Doc { @PrimaryColumn() id: string; @Column() userId: string; }`,
    "src/routes.ts": `import typeorm from "typeorm";
app.get("/docs/:id", requireAuth, async (req, res) => {
  const doc = await this.em.findOne(Doc, { id: req.params.id });
  if (doc.userId !== req.user.id) return res.sendStatus(404);
  res.json(doc);
});
app.get("/docs2/:id", requireAuth, async (req, res) => {
  res.json(await em.findOne(Doc, req.params.id));
});
`
  });
  assert.deepEqual(at(f), ["AUTH002:routes.ts:8"]);
});

test("Sequelize: Model.init owner column, findByPk IDOR, update(data, { where }) scoped, destroy unscoped", () => {
  const f = scan({
    ...NO_PRISMA,
    "models/note.js": `const { Model, DataTypes } = require("sequelize");
class Note extends Model {}
Note.init({ body: DataTypes.TEXT, ownerId: { type: DataTypes.INTEGER, field: "owner_id" } }, { sequelize, tableName: "notes" });
module.exports = Note;`,
    "routes.js": `const express = require("express");
const router = express.Router();
router.get("/notes/:id", ensureAuthenticated, async (req, res) => {
  res.json(await Note.findByPk(req.params.id));
});
router.put("/notes/:id", ensureAuthenticated, async (req, res) => {
  await Note.update({ body: req.body.body }, { where: { id: req.params.id, ownerId: req.user.id } });
  res.end();
});
router.delete("/notes/:id", ensureAuthenticated, async (req, res) => {
  await Note.destroy({ where: { id: req.params.id } });
  res.end();
});
router.post("/notes", ensureAuthenticated, async (req, res) => {
  res.json(await Note.create(req.body));
});
`
  });
  assert.deepEqual(at(f), ["AUTH002:routes.js:4", "AUTH003:routes.js:11", "AUTH004:routes.js:15"]);
});

test("Sequelize: sequelize.define and belongsTo(User) add the owner key", () => {
  const f = scan({
    ...NO_PRISMA,
    "models/index.js": `const Sequelize = require("sequelize");
const Task = sequelize.define("Task", { title: Sequelize.STRING });
Task.belongsTo(User);`,
    "routes.js": `const express = require("express");
app.get("/tasks", ensureAuthenticated, async (req, res) => res.json(await Task.findAll()));
app.get("/tasks/mine", ensureAuthenticated, async (req, res) => res.json(await Task.findAll({ where: { UserId: req.user.id } })));
`
  });
  assert.deepEqual(at(f), ["AUTH002:routes.js:2"]);
});

test("Mongoose: ref to User makes an owner field; findById, $set, new Model(body), .equals check", () => {
  const f = scan({
    ...NO_PRISMA,
    "models/Post.js": `const mongoose = require("mongoose");
const PostSchema = new mongoose.Schema({ title: String, user: { type: mongoose.Schema.Types.ObjectId, ref: "User" } });
module.exports = mongoose.model("Post", PostSchema);`,
    "routes/posts.js": `const express = require("express");
const Post = require("../models/Post");
router.get("/:id", protect, async (req, res) => {
  res.json(await Post.findById(req.params.id));
});
router.get("/ok/:id", protect, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post.user.equals(req.user._id)) return res.status(404).end();
  res.json(post);
});
router.put("/:id", protect, async (req, res) => {
  res.json(await Post.findOneAndUpdate({ _id: req.params.id, user: req.user.id }, { $set: req.body }));
});
router.delete("/:id", protect, async (req, res) => {
  res.json(await Post.findByIdAndDelete(req.params.id));
});
router.post("/", protect, async (req, res) => {
  const post = new Post(req.body);
  res.json(await post.save());
});
`
  });
  assert.deepEqual(at(f), ["AUTH002:posts.js:4", "AUTH003:posts.js:15", "AUTH004:posts.js:12", "AUTH004:posts.js:18"]);
});

test("Mongoose: toString() ownership comparison counts", () => {
  const f = scan({
    ...NO_PRISMA,
    "models/Post.js": `const mongoose = require("mongoose");
const S = new mongoose.Schema({ owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" } });
const Post = mongoose.model("Post", S);`,
    "routes.js": `const express = require("express");
app.get("/p/:id", protect, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (post.owner.toString() !== req.user.id) return res.status(403).end();
  res.json(post);
});`
  });
  assert.deepEqual(ids(f), []);
});

test("Kysely and Knex: tables from SQL migrations; string-column filters", () => {
  const f = scan({
    ...NO_PRISMA,
    "migrations/001_init.sql": `CREATE TABLE invoices (id serial primary key, user_id int not null, total int);`,
    "src/app.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/k/:id", requireAuth, async (c) => c.json(await db.selectFrom("invoices").selectAll().where("id", "=", c.req.param("id")).executeTakeFirst()));
app.get("/k2/:id", requireAuth, async (c) => c.json(await db.selectFrom("invoices").selectAll().where("id", "=", c.req.param("id")).where("user_id", "=", c.get("user").id).executeTakeFirst()));
app.delete("/x/:id", requireAuth, async (c) => c.json(await knex("invoices").where({ id: c.req.param("id") }).del()));
app.put("/x/:id", requireAuth, async (c) => c.json(await knex("invoices").where({ id: c.req.param("id"), user_id: c.get("user").id }).update(await c.req.json())));
`
  });
  assert.deepEqual(at(f), ["AUTH002:app.ts:3", "AUTH003:app.ts:5", "AUTH004:app.ts:6"]);
});

test("Knex: tables from Knex migrations; unauthenticated write is AUTH001", () => {
  const f = scan({
    ...NO_PRISMA,
    "migrations/20240101_init.js": `exports.up = (knex) => knex.schema.createTable("orders", (t) => { t.increments("id"); t.integer("account_id"); });
exports.down = (knex) => knex.schema.dropTable("orders");`,
    "server.js": `const express = require("express");
app.post("/orders/:id/cancel", async (req, res) => {
  await knex("orders").where({ id: req.params.id }).update({ status: "cancelled" });
  res.end();
});`
  });
  assert.deepEqual(at(f), ["AUTH001:server.js:2"]);
});

test("Prisma and other-ORM models with the same accessor style do not collide", () => {
  // db.post (Prisma) keeps Prisma semantics; postRepository is ignored without a TypeORM model
  const f = scan({
    "src/routes.ts": `import express from "express";
app.get("/p/:id", requireAuth, async (req, res) => res.json(await db.post.findUnique({ where: { id: req.params.id } })));
app.get("/r/:id", requireAuth, async (req, res) => res.json(await postRepository.findOne({ where: { id: req.params.id } })));
`
  });
  assert.deepEqual(at(f), ["AUTH002:routes.ts:2"]);
});

test("Arrays named like models are not database calls", () => {
  const f = scan({
    "prisma/schema.prisma": "",
    "src/entity/Post.ts": `import { Entity, Column } from "typeorm";\n@Entity() export class Post { @Column() userId: string; }`,
    "src/routes.ts": `import express from "express";
app.get("/p/:id", requireAuth, async (req, res) => {
  const posts = await load();
  res.json(posts.find((p) => p.id === req.params.id));
});`
  });
  assert.deepEqual(f, []);
});
