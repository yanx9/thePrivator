import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("ThePrivator desktop shell scaffold", () => {
  it("renders the branded rewrite heading", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: /theprivator rewrite spine/i }),
    ).toBeInTheDocument();
  });

  it("reserves the sidecar health and recoverable error regions", () => {
    render(<App />);

    expect(screen.getByLabelText(/health region/i)).toHaveTextContent(
      /awaiting sidecar contract/i,
    );
    expect(screen.getByLabelText(/recoverable error region/i)).toHaveTextContent(
      /detailRef/i,
    );
  });
});
