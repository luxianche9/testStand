// hwcli_pci1762: JSON-line bridge to an Advantech PCI-1762 (16 relays, 16 isolated DI) via DAQNavi.
//
// Commands: ping, enumerate, open {description}, close, set_relay {channel, closed},
// set_bank {mask}, read_bit {channel, kind: DI|RELAY|DO}, read_mask {kind}, safe_state.
// Relays are DO ports 0..1 (bit i of the 16-bit mask is RELAY i); IDI0..15 are DI ports 0..1.
// close drives every relay open first; stdin EOF closes the board the same way.
// The relay readback trails a write (a few milliseconds, longer while the system is busy), so
// every write waits up to kSettleMs until the readback shows it before replying; a later read then
// sees the new state. A readback that never follows is reported as a failure of the write.

#include <chrono>
#include <string>
#include <thread>

// windows.h (via jsonline.hpp) must come first: MinGW defines __int64 there, which bdaqctrl.h needs.
#include "common/jsonline.hpp"

#include <bdaqctrl.h>

using namespace Automation::BDaq;
using hwcli::Request;

namespace {

constexpr int kChannels = 16;
constexpr int kPorts = 2;
constexpr int kSettleMs = 250;

InstantDoCtrl *relays = nullptr;
InstantDiCtrl *inputs = nullptr;
bool succeeded(ErrorCode code) { return BioFailed(code) == false; }

std::string error_text(const char *what, ErrorCode code) { return std::string(what) + " failed " + hwcli::hex(code); }

void release() {
    if (relays != nullptr) relays->Dispose();
    if (inputs != nullptr) inputs->Dispose();
    relays = nullptr;
    inputs = nullptr;
}

bool is_relay_kind(const std::string &kind) { return kind == "RELAY" || kind == "DO"; }

std::string upper(std::string text) {
    for (char &c : text) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
    return text;
}

ErrorCode read_ports(const std::string &kind, unsigned &mask) {
    uint8 data[kPorts] = {0, 0};
    ErrorCode code = is_relay_kind(kind) ? relays->Read(0, kPorts, data) : inputs->Read(0, kPorts, data);
    mask = static_cast<unsigned>(data[0]) | static_cast<unsigned>(data[1]) << 8;
    return code;
}

// Poll the relay readback until the bits in ``care`` equal ``expected`` or kSettleMs pass.
ErrorCode settle(unsigned expected, unsigned care, unsigned &mask) {
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kSettleMs);
    while (true) {
        ErrorCode code = read_ports("RELAY", mask);
        if (!succeeded(code) || (mask & care) == (expected & care) || std::chrono::steady_clock::now() >= deadline) {
            return code;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

// Open every relay and confirm the readback is all zero.
bool open_all(std::string &error) {
    uint8 zeros[kPorts] = {0, 0};
    ErrorCode code = relays->Write(0, kPorts, zeros);
    if (!succeeded(code)) {
        error = error_text("WriteAny zeros", code);
        return false;
    }
    unsigned mask = 0;
    code = settle(0, 0xFFFF, mask);
    if (!succeeded(code)) {
        error = error_text("ReadAny verify", code);
        return false;
    }
    if (mask != 0) {
        error = "Relay readback after safe_state is " + hwcli::hex(mask) + ", expected 0";
        return false;
    }
    return true;
}

void enumerate() {
    InstantDoCtrl *probe = InstantDoCtrl::Create();
    Array<DeviceTreeNode> *devices = probe->getSupportedDevices();
    std::string list = "[";
    int count = devices != nullptr ? devices->getCount() : 0;
    for (int i = 0; i < count; ++i) {
        DeviceTreeNode &node = devices->getItem(i);
        if (i > 0) list += ",";
        list += "{\"index\":" + std::to_string(i) + ",\"deviceNumber\":" + std::to_string(node.DeviceNumber) +
                ",\"description\":" + hwcli::quote(hwcli::narrow(node.Description)) + "}";
    }
    list += "]";
    if (devices != nullptr) devices->Dispose();
    probe->Dispose();
    hwcli::ok(std::to_string(count) + " device(s)", list);
}

void open(const Request &request) {
    std::string description = hwcli::text(request, "description", "PCI-1762,BID#0");
    release();
    relays = InstantDoCtrl::Create();
    inputs = InstantDiCtrl::Create();
    std::wstring wide = hwcli::wide(description);
    ErrorCode code = relays->setSelectedDevice(DeviceInformation(wide.c_str(), ModeWrite));
    if (!succeeded(code)) {
        release();
        return hwcli::fail("Device '" + description + "' not in DAQNavi list: " + error_text("DO setSelectedDevice", code));
    }
    code = inputs->setSelectedDevice(DeviceInformation(wide.c_str(), ModeRead));
    if (!succeeded(code)) {
        release();
        return hwcli::fail(error_text("DI setSelectedDevice", code));
    }
    hwcli::ok("opened", "{\"description\":" + hwcli::quote(description) + ",\"portCount\":" +
                            std::to_string(relays->getPortCount()) + "}");
}

void close() {
    std::string error;
    bool safe = relays == nullptr || open_all(error);
    release();
    if (!safe) return hwcli::fail("Closed, but safe_state failed: " + error);
    hwcli::ok("Closed after safe_state", "{\"open\":false}");
}

void handle(const Request &request) {
    std::string command = hwcli::text(request, "cmd");
    if (command == "ping") return hwcli::ok("pong", "{}");
    if (command == "enumerate") return enumerate();
    if (command == "open") return open(request);
    if (command == "close") return close();
    if (relays == nullptr) return hwcli::fail("Not open");

    if (command == "set_relay") {
        long channel = hwcli::integer(request, "channel", -1);
        if (channel < 0 || channel >= kChannels) return hwcli::fail("channel must be 0..15");
        bool closed = hwcli::flag(request, "closed");
        ErrorCode code = relays->WriteBit(channel / 8, channel % 8, closed ? 1 : 0);
        if (!succeeded(code)) return hwcli::fail(error_text("WriteBit", code));
        unsigned readback = 0;
        code = settle(closed ? 1u << channel : 0, 1u << channel, readback);
        if (!succeeded(code)) return hwcli::fail(error_text("ReadAny verify", code));
        if (((readback >> channel) & 1u) != (closed ? 1u : 0u)) {
            return hwcli::fail("Relay written but its readback did not follow within " + std::to_string(kSettleMs) +
                               " ms (readback " + hwcli::hex(readback) + ")");
        }
        return hwcli::ok(closed ? "relay closed (actuates)" : "relay opened",
                         "{\"channel\":" + std::to_string(channel) + ",\"closed\":" + hwcli::boolean(closed) +
                             ",\"port\":" + std::to_string(channel / 8) + ",\"bit\":" + std::to_string(channel % 8) +
                             "}");
    }
    if (command == "set_bank") {
        long mask = hwcli::integer(request, "mask", -1);
        if (mask < 0 || mask > 0xFFFF) return hwcli::fail("mask must be 0..65535");
        uint8 data[kPorts] = {static_cast<uint8>(mask & 0xFF), static_cast<uint8>((mask >> 8) & 0xFF)};
        ErrorCode code = relays->Write(0, kPorts, data);
        if (!succeeded(code)) return hwcli::fail(error_text("WriteAny", code));
        unsigned readback = 0;
        code = settle(static_cast<unsigned>(mask), 0xFFFF, readback);
        if (!succeeded(code)) return hwcli::fail(error_text("ReadAny verify", code));
        if (readback != static_cast<unsigned>(mask)) {
            return hwcli::fail("Relays written but the readback did not follow within " + std::to_string(kSettleMs) +
                               " ms (readback " + hwcli::hex(readback) + ")");
        }
        return hwcli::ok("set_bank written (actuates)", "{\"mask\":" + std::to_string(mask) + "}");
    }
    if (command == "read_bit") {
        long channel = hwcli::integer(request, "channel", -1);
        if (channel < 0 || channel >= kChannels) return hwcli::fail("channel must be 0..15");
        std::string kind = upper(hwcli::text(request, "kind", "DI"));
        uint8 value = 0;
        ErrorCode code = is_relay_kind(kind) ? relays->ReadBit(channel / 8, channel % 8, &value)
                                             : inputs->ReadBit(channel / 8, channel % 8, &value);
        if (!succeeded(code)) return hwcli::fail(error_text("ReadBit", code));
        return hwcli::ok("read_bit", "{\"kind\":" + hwcli::quote(kind) + ",\"channel\":" + std::to_string(channel) +
                                         ",\"value\":" + hwcli::boolean(value != 0) + "}");
    }
    if (command == "read_mask") {
        std::string kind = upper(hwcli::text(request, "kind", "DI"));
        unsigned mask = 0;
        ErrorCode code = read_ports(kind, mask);
        if (!succeeded(code)) return hwcli::fail(error_text("ReadAny", code));
        return hwcli::ok("read_mask", "{\"kind\":" + hwcli::quote(kind) + ",\"mask\":" + std::to_string(mask) + "}");
    }
    if (command == "safe_state") {
        std::string error;
        if (!open_all(error)) return hwcli::fail(error);
        return hwcli::ok("All relays opened (safe_state)", "{\"relays\":\"all_open\"}");
    }
    hwcli::fail("Unknown command " + command, false);
}

}  // namespace

int main() {
    int result = hwcli::serve(handle);
    if (relays != nullptr) {
        std::string error;
        open_all(error);
        release();
    }
    return result;
}
