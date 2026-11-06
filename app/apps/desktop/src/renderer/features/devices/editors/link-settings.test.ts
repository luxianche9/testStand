import { describe, expect, it } from "vitest";
import { linkIssues, linkKind, linkValue, withLinkKind } from "./link-settings.js";

describe("communication link settings", () => {
  it("switches the kind with defaults, keeping other settings and the values that still apply", () => {
    const serial = withLinkKind({ rxBufferBytes: 4096 }, "serial");
    expect(serial).toEqual({
      rxBufferBytes: 4096, link: "serial", port: "COM3", baudrate: 115200, bytesize: 8, parity: "N", stopbits: 1
    });
    expect(withLinkKind({ ...serial, baudrate: 9600 }, "serial").baudrate).toBe(9600);
    // A serial port name never becomes a TCP port number.
    expect(withLinkKind(serial, "tcp_client")).toEqual({
      rxBufferBytes: 4096, link: "tcp_client", host: "192.168.1.10", port: 502
    });
    expect(withLinkKind(serial, "")).toEqual({ rxBufferBytes: 4096 });
    expect(linkKind({ link: "bogus" })).toBe("");
  });

  it("reads numbers for numeric keys and COM names in capitals", () => {
    expect(linkValue("baudrate", "9600")).toBe(9600);
    expect(linkValue("port", "502")).toBe(502);
    expect(linkValue("port", " com12 ")).toBe("COM12");
    expect(linkValue("host", " 10.0.0.2 ")).toBe("10.0.0.2");
    expect(linkValue("parity", "e")).toBe("E");
  });

  it("says what is missing before the device is saved", () => {
    expect(linkIssues(withLinkKind({}, "serial"))).toEqual({});
    expect(linkIssues({ link: "serial", port: "/dev/ttyS0", baudrate: 10 })).toEqual({
      port: "如 COM3", baudrate: "50–4000000"
    });
    expect(linkIssues({ link: "tcp_client", host: "", port: 0 })).toEqual({ host: "IP 地址或主机名", port: "端口号 1–65535" });
    expect(linkIssues({ link: "udp", localPort: 0 })).toEqual({});
    expect(linkIssues({ link: "udp", localPort: 0, host: "10.0.0.2", port: 0 })).toEqual({ port: "端口号 1–65535" });
    expect(linkIssues({})).toEqual({});
  });
});
