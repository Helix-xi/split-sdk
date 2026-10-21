import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DisputeTimeline } from "../../src/ui/DisputeTimeline.js";
import { WhiteLabelProvider } from "../../src/ui/WhiteLabelProvider.js";

describe("WhiteLabelProvider", () => {
  it("applies brand identity, labels, and theme tokens to SDK UI", () => {
    render(
      <WhiteLabelProvider
        config={{
          brandName: "Northstar Pay",
          logoUrl: "/northstar.svg",
          labels: { disputeTimeline: "Case activity", noEvents: "Nothing to review" },
          theme: { primary: "#125a48", surface: "#f7fbf9" },
        }}
      >
        <>
          <DisputeTimeline
            events={[{
              id: "event-1",
              type: "dispute_opened",
              timestamp: 1_700_000_000,
              actor: "GACTOR",
              description: "Dispute opened",
            }]}
          />
          <DisputeTimeline events={[]} />
        </>
      </WhiteLabelProvider>,
    );

    expect(screen.getByText("Northstar Pay")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Northstar Pay" })).toHaveAttribute("src", "/northstar.svg");
    expect(screen.getByText("Case activity")).toBeInTheDocument();
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();

    const provider = screen.getByTestId("white-label-brand").parentElement;
    expect(provider?.style.getPropertyValue("--stellar-split-primary")).toBe("#125a48");
    expect(provider?.style.getPropertyValue("--stellar-split-surface")).toBe("#f7fbf9");
  });

  it("merges nested label configuration", () => {
    render(
      <WhiteLabelProvider config={{ labels: { noEvents: "Parent copy", active: "Open" } }}>
        <WhiteLabelProvider config={{ labels: { noEvents: "Nested copy" } }}>
          <DisputeTimeline events={[]} />
        </WhiteLabelProvider>
      </WhiteLabelProvider>,
    );

    expect(screen.getByText("Nested copy")).toBeInTheDocument();
  });
});