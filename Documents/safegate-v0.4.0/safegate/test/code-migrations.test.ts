import { test } from "node:test";
import * as assert from "node:assert/strict";
import { scan } from "./helpers";

const NO_PRISMA = { "prisma/schema.prisma": "" };
const at = (findings: { ruleId: string; line: number; file: string }[]) => findings.map((f) => `${f.ruleId}:${f.line}`).sort();
const mig = (files: Record<string, string>, pick: string) => scan({ ...NO_PRISMA, ...files }, { only: "migrations" }).filter((f) => f.file.includes(pick));

test("Rails: add_index without concurrently, remove_column, NOT NULL without default, safe forms pass", () => {
  const f = mig(
    {
      "db/migrate/20240101000000_create_posts.rb": `class CreatePosts < ActiveRecord::Migration[7.1]
  def change
    create_table :posts do |t|
      t.string :title
    end
    add_index :posts, :title
  end
end`,
      "db/migrate/20240201000000_change_posts.rb": `class ChangePosts < ActiveRecord::Migration[7.1]
  disable_ddl_transaction!
  def up
    add_index :posts, :user_id
    add_index :posts, :slug, algorithm: :concurrently
    add_column :posts, :status, :string, null: false
    add_column :posts, :kind, :string, null: false, default: "a"
    remove_column :posts, :legacy
    rename_column :posts, :body, :content
    safety_assured { remove_column :posts, :old }
  end
  def down
    remove_index :posts, :user_id
  end
end`
    },
    "change_posts"
  );
  assert.deepEqual(at(f), ["MIG001:4", "MIG003:6", "MIG008:9", "MIG010:8"]);
  assert.match(f.find((x) => x.ruleId === "MIG001")!.fix, /algorithm: :concurrently/);
});

test("Django: AddField with db_index, RemoveField, AddIndex; CreateModel in same file is new", () => {
  const f = mig(
    {
      "blog/migrations/0002_changes.py": `from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [("blog", "0001_initial")]
    operations = [
        migrations.CreateModel(name="Tag", fields=[("id", models.AutoField(primary_key=True))]),
        migrations.AddIndex(model_name="tag", index=models.Index(fields=["id"], name="tag_idx")),
        migrations.AddField(model_name="post", name="slug", field=models.SlugField(db_index=True)),
        migrations.RemoveField(model_name="post", name="legacy"),
        migrations.AddIndex(model_name="post", index=models.Index(fields=["title"], name="title_idx")),
    ]`
    },
    "0002"
  );
  assert.deepEqual(at(f), ["MIG001:10", "MIG001:8", "MIG010:9"]);
  assert.match(f[0].fix, /AddIndexConcurrently/);
});

test("Alembic: create_index, nullable=False column, drop_column; downgrade ignored; raw SQL analyzed", () => {
  const f = mig(
    {
      "alembic/versions/abc123_change.py": `from alembic import op
import sqlalchemy as sa

def upgrade():
    op.create_index("ix_posts_user", "posts", ["user_id"])
    op.add_column("posts", sa.Column("status", sa.String(), nullable=False))
    op.drop_column("posts", "legacy")
    op.execute("ALTER TABLE posts ALTER COLUMN title SET NOT NULL")

def downgrade():
    op.drop_index("ix_posts_user", table_name="posts")
`
    },
    "abc123"
  );
  assert.deepEqual(at(f), ["MIG001:5", "MIG002:8", "MIG003:6", "MIG010:7"]);
});

test("Laravel: index, required column, dropColumn inside Schema::table; Schema::create is new", () => {
  const f = mig(
    {
      "database/migrations/2024_01_01_000000_change_posts.php": `<?php
return new class extends Migration {
    public function up(): void
    {
        Schema::create('tags', function (Blueprint $table) {
            $table->id();
            $table->index('id');
        });
        Schema::table('posts', function (Blueprint $table) {
            $table->index('user_id');
            $table->string('status');
            $table->string('note')->nullable();
            $table->dropColumn('legacy');
        });
    }
    public function down(): void
    {
        Schema::dropIfExists('tags');
    }
};`
    },
    "change_posts"
  );
  assert.deepEqual(at(f), ["MIG001:10", "MIG003:11", "MIG010:13"]);
});

test("Knex, Sequelize, TypeORM, node-pg-migrate: index without concurrently, drop column, down ignored", () => {
  const files = {
    "migrations/20240101_knex.js": `exports.up = async (knex) => {
  await knex.schema.alterTable("posts", (t) => {
    t.index(["user_id"]);
    t.dropColumn("legacy");
  });
};
exports.down = async (knex) => {
  await knex.schema.dropTable("posts");
};`,
    "migrations/20240102-seq.js": `module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex("posts", ["user_id"]);
    await queryInterface.addColumn("posts", "status", { type: Sequelize.STRING, allowNull: false });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("posts", "status");
  }
};`,
    "src/migrations/1700000000000-Change.ts": `import { MigrationInterface, QueryRunner, TableIndex } from "typeorm";
export class Change1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`CREATE INDEX "IDX_user" ON "posts" ("user_id")\`);
    await queryRunner.dropColumn("posts", "legacy");
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`DROP INDEX "IDX_user"\`);
  }
}`,
    "migrations/1700000000001_pg.js": `exports.up = (pgm) => {
  pgm.createIndex("posts", "user_id");
  pgm.createIndex("posts", "slug", { concurrently: true });
  pgm.dropColumns("posts", ["legacy"]);
};
exports.down = (pgm) => {
  pgm.dropIndex("posts", "user_id");
};`
  };
  assert.deepEqual(at(mig(files, "_knex")), ["MIG001:3", "MIG010:4"]);
  assert.deepEqual(at(mig(files, "-seq")), ["MIG001:3", "MIG003:4"]);
  assert.deepEqual(at(mig(files, "-Change")), ["MIG001:4", "MIG010:5"]);
  assert.deepEqual(at(mig(files, "_pg")), ["MIG001:2", "MIG010:4"]);
});

test("XCHK001 from a code migration: dropped column still used by app code (migration file itself excluded)", () => {
  const f = scan(
    {
      ...NO_PRISMA,
      "migrations/20240101_drop.js": `exports.up = (knex) => knex.schema.table("users", (t) => { t.dropColumn("nickname"); });
exports.down = (knex) => knex.schema.table("users", (t) => { t.string("nickname"); });`,
      "src/profile.ts": `export const show = (u: any) => knex("users").select("nickname").where({ id: u.id });`
    },
    { only: "migrations" }
  );
  assert.deepEqual(f.map((x) => x.ruleId).sort(), ["MIG010", "XCHK001"]);
  assert.match(f.find((x) => x.ruleId === "XCHK001")!.message, /profile\.ts:1/);
});
