import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createProxyDraftState } from "../../proxyControls";
import { ProxyForm } from "./ProxyForm";

function Form() {
  const [draft, setDraft] = useState(createProxyDraftState(null));
  return <ProxyForm draft={draft} onChange={setDraft} />;
}

function paste(label: string, text: string) {
  fireEvent.paste(screen.getByLabelText(label), { clipboardData: { getData: () => text } });
}

describe("ProxyForm clipboard input", () => {
  it("fills a proxy from Direct mode and keeps passwords masked", () => {
    render(<Form />);
    paste("Paste proxy", "socks5://alice:secret@proxy.example:1080");
    expect(screen.getByLabelText("Proxy mode")).toHaveValue("fixedServer");
    expect(screen.getByLabelText("Protocol")).toHaveValue("socks5");
    expect(screen.getByLabelText("Host")).toHaveValue("proxy.example");
    expect(screen.getByLabelText("Port")).toHaveValue("1080");
    expect(screen.getByLabelText("Username")).toHaveValue("alice");
    expect(screen.getByLabelText("Password")).toHaveValue("secret");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Paste proxy")).toHaveValue("");
  });

  it("accepts full proxy pastes into Host and clears old authentication", () => {
    render(<Form />);
    paste("Paste proxy", "proxy.example:8080:alice:secret");
    paste("Host", "https://new.example:443");
    expect(screen.getByLabelText("Host")).toHaveValue("new.example");
    expect(screen.getByLabelText("Protocol")).toHaveValue("https");
    expect(screen.getByLabelText("Port")).toHaveValue("443");
    expect(screen.getByLabelText("Credential mode")).toHaveValue("none");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("leaves fields intact after an invalid paste and shows a safe error", () => {
    render(<Form />);
    paste("Paste proxy", "proxy.example:8080");
    paste("Host", "http://alice:private-secret@new.example:99999");
    expect(screen.getByLabelText("Host")).toHaveValue("proxy.example");
    expect(screen.getByRole("alert")).toHaveTextContent(/port/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/alice|private-secret/);
    paste("Paste proxy", "new.example:80");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows typed input to be applied with Enter", () => {
    render(<Form />);
    fireEvent.change(screen.getByLabelText("Paste proxy"), { target: { value: "proxy.example:80" } });
    fireEvent.keyDown(screen.getByLabelText("Paste proxy"), { key: "Enter" });
    expect(screen.getByLabelText("Host")).toHaveValue("proxy.example");
    expect(screen.getByLabelText("Port")).toHaveValue("80");
  });
});
