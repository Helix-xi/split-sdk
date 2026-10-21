import { describe, it, expect } from "vitest";
import { RpcConnectionPool } from "../src/connectionPool.js";
import { RequestDebouncer } from "../src/requestDebouncer.js";
import { ObjectPool, MemoryOptimizer } from "../src/memoryOptimizer.js";
import { StreamingDatasetIterator } from "../src/streamingDataset.js";

describe("Issues #1136, #1137, #1138, #1139", () => {
  describe("Issue #1136: RpcConnectionPool", () => {
    it("manages connection acquisition, release and statistics", async () => {
      const pool = new RpcConnectionPool("https://horizon-testnet.stellar.org", {
        minConnections: 2,
        maxConnections: 5,
      });

      const statsInitial = pool.getStats();
      expect(statsInitial.totalConnections).toBe(2);

      const conn1 = await pool.acquire();
      const conn2 = await pool.acquire();

      expect(pool.getStats().activeConnections).toBe(2);

      const result = await conn1.execute(async () => 42);
      expect(result).toBe(42);

      pool.release(conn1);
      expect(pool.getStats().activeConnections).toBe(1);

      pool.release(conn2);
      expect(pool.getStats().activeConnections).toBe(0);

      pool.destroy();
    });
  });

  describe("Issue #1137: RequestDebouncer", () => {
    it("deduplicates concurrent in-flight requests to same key", async () => {
      const debouncer = new RequestDebouncer({ windowMs: 20 });
      let callCount = 0;

      const action = async () => {
        callCount++;
        return "response_data";
      };

      const [res1, res2, res3] = await Promise.all([
        debouncer.execute("endpoint_a", action),
        debouncer.execute("endpoint_a", action),
        debouncer.execute("endpoint_a", action),
      ]);

      expect(res1).toBe("response_data");
      expect(res2).toBe("response_data");
      expect(res3).toBe("response_data");
      expect(callCount).toBe(1);
      expect(debouncer.getDuplicateSavedCount()).toBe(2);
    });
  });

  describe("Issue #1138: MemoryOptimizer & ObjectPool", () => {
    it("reuses pooled objects to reduce memory allocations", () => {
      interface BufferItem {
        id: number;
        data: string;
      }

      let allocs = 0;
      const pool = new ObjectPool<BufferItem>(
        () => ({ id: ++allocs, data: "" }),
        (item) => {
          item.data = "";
        }
      );

      const obj1 = pool.acquire();
      obj1.data = "used";
      pool.release(obj1);

      const obj2 = pool.acquire();
      expect(obj2.id).toBe(obj1.id);
      expect(obj2.data).toBe("");
      expect(allocs).toBe(1);

      const report = MemoryOptimizer.report();
      expect(report.poolAllocations).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Issue #1139: StreamingDatasetIterator", () => {
    it("paginates and streams large datasets using cursors", async () => {
      const allItems = Array.from({ length: 25 }, (_, i) => `item_${i + 1}`);

      const iterator = new StreamingDatasetIterator<string>({
        chunkSize: 10,
        fetchPage: async (cursor, limit = 10) => {
          const startIndex = cursor ? parseInt(cursor, 10) : 0;
          const items = allItems.slice(startIndex, startIndex + limit);
          const nextIndex = startIndex + limit;
          const hasMore = nextIndex < allItems.length;
          return {
            items,
            nextCursor: hasMore ? nextIndex.toString() : undefined,
            hasMore,
          };
        },
      });

      const page1 = await iterator.nextPage();
      expect(page1.items.length).toBe(10);
      expect(page1.items[0]).toBe("item_1");

      const page2 = await iterator.nextPage();
      expect(page2.items.length).toBe(10);
      expect(page2.items[0]).toBe("item_11");

      const streamed: string[] = [];
      const freshIterator = new StreamingDatasetIterator<string>({
        chunkSize: 10,
        fetchPage: async (cursor, limit = 10) => {
          const startIndex = cursor ? parseInt(cursor, 10) : 0;
          const items = allItems.slice(startIndex, startIndex + limit);
          const nextIndex = startIndex + limit;
          const hasMore = nextIndex < allItems.length;
          return {
            items,
            nextCursor: hasMore ? nextIndex.toString() : undefined,
            hasMore,
          };
        },
      });

      for await (const item of freshIterator.stream()) {
        streamed.push(item);
      }
      expect(streamed.length).toBe(25);
    });
  });
});
