import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SUPPORTED_LOCALES,
  detectLanguage,
  setLocale,
  getLocale,
  listLocales,
  t,
  translateErrorCode,
  translateStatus,
  tp,
  registerTranslations,
  registerLocale,
  _resetI18nForTesting,
} from "../src/i18n.js";

describe("i18n (Issue #1049)", () => {
  beforeEach(() => {
    _resetI18nForTesting();
  });

  afterEach(() => {
    _resetI18nForTesting();
  });

  describe("supported locales", () => {
    it("should list all bundled locales", () => {
      expect(SUPPORTED_LOCALES).toContain("en");
      expect(SUPPORTED_LOCALES).toContain("es");
      expect(SUPPORTED_LOCALES).toContain("fr");
      expect(SUPPORTED_LOCALES).toContain("de");
      expect(SUPPORTED_LOCALES).toContain("pt");
      expect(SUPPORTED_LOCALES).toContain("zh");
      expect(SUPPORTED_LOCALES).toContain("ja");
    });
  });

  describe("language detection", () => {
    it("should detect language from explicit hint", () => {
      expect(detectLanguage("es")).toBe("es");
      expect(detectLanguage("pt-BR")).toBe("pt");
      expect(detectLanguage("fr-FR")).toBe("fr");
    });

    it("should fall back to English for unknown locales", () => {
      expect(detectLanguage("zz-XX")).toBe("en");
      expect(detectLanguage(undefined)).toBe("en");
      expect(detectLanguage("")).toBe("en");
    });

    it("should normalize underscores and case", () => {
      expect(detectLanguage("EN_US")).toBe("en");
      expect(detectLanguage("pt_BR")).toBe("pt");
    });
  });

  describe("locale switching", () => {
    it("should set and get locale", () => {
      expect(setLocale("fr")).toBe("fr");
      expect(getLocale()).toBe("fr");
      expect(setLocale("de")).toBe("de");
      expect(getLocale()).toBe("de");
    });

    it("should fall back to default for invalid locale", () => {
      expect(setLocale("xx")).toBe("en");
      expect(getLocale()).toBe("en");
    });
  });

  describe("translation", () => {
    it("should translate keys with interpolation", () => {
      setLocale("en");
      expect(t("error.invoiceNotFound", { invoiceId: "42" })).toBe("Invoice not found: 42");
    });

    it("should translate Spanish", () => {
      setLocale("es");
      expect(t("error.invoiceNotFound", { invoiceId: "42" })).toBe("Factura no encontrada: 42");
    });

    it("should translate French", () => {
      setLocale("fr");
      expect(t("error.invoiceNotFound", { invoiceId: "7" })).toBe("Facture introuvable : 7");
    });

    it("should translate Chinese", () => {
      setLocale("zh");
      expect(t("error.invoiceNotFound", { invoiceId: "42" })).toBe("本发票不存在：42");
    });

    it("should translate Japanese", () => {
      setLocale("ja");
      expect(t("error.invoiceNotFound", { invoiceId: "42" })).toBe("請求書が見つかりません: 42");
    });

    it("should translate error codes", () => {
      setLocale("fr");
      expect(translateErrorCode("INVOICE_NOT_FOUND", { invoiceId: "7" })).toBe(
        "Facture introuvable : 7"
      );
    });

    it("should translate status values", () => {
      setLocale("de");
      expect(translateStatus("Pending")).toBe("Ausstehend");
      expect(translateStatus("Released")).toBe("Freigegeben");
    });

    it("should fall back to key for unknown key", () => {
      expect(t("unknown.key.zzz")).toBe("unknown.key.zzz");
    });

    it("should return translated title for a known locale", () => {
      setLocale("ja");
      expect(t("invoice.export.title", undefined, "ja")).toBe("StellarSplit請求書");
    });
  });

  describe("pluralization (tp)", () => {
    it("should pick singular for count 1", () => {
      setLocale("en");
      expect(tp("invoice.status.pending", "invoice.status.pending", 1)).toBe("Pending");
    });

    it("should pick plural for count other than 1", () => {
      setLocale("en");
      expect(tp("x", "y", 2, { count: 2 })).toBe("y");
    });
  });

  describe("registering translations", () => {
    it("should register and use a custom locale", () => {
      registerTranslations("xx", { "error.generic": "Custom error: {reason}" });
      setLocale("xx");
      expect(t("error.generic", { reason: "boom" })).toBe("Custom error: boom");
      expect(listLocales()).toContain("xx");
    });

    it("registerLocale is an alias for registerTranslations", () => {
      expect(typeof registerLocale).toBe("function");
      expect(registerLocale).toBe(registerTranslations);
    });
  });

  describe("listLocales", () => {
    it("should list builtin locales", () => {
      const locales = listLocales();
      expect(locales).toContain("en");
      expect(locales).toContain("es");
    });
  });
});
