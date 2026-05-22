import { createRouter } from "../router";

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const mockConfig = {
  has: jest.fn(() => false),
  getOptionalString: jest.fn(() => undefined),
  getString: jest.fn(() => ""),
};

describe("createRouter", () => {
  it("should create a router", async () => {
    const router = await createRouter({
      config: mockConfig as any,
      logger: mockLogger as any,
    });
    expect(router).toBeDefined();
  });
});
