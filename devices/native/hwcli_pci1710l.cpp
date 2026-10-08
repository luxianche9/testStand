// hwcli_pci1710l: JSON-line bridge to an Advantech PCI-1710L (16 AI, 16 DI, 16 DO) via DAQNavi.
//
// Commands: ping, enumerate, open {description, safe_do_mask}, close,
// configure_ai {channel, signal_type, value_range}, read_voltage {channel},
// set_level {channel, level}, read_bit {channel, kind: DI|DO}, read_mask {kind}, safe_state.
// DO0..15 and DI0..15 are ports 0..1; value_range is the DAQNavi ValueRange enum (1 = +/-10 V).
// read_voltage requires configure_ai on that channel first. safe_state writes safe_do_mask;
// close applies it first, and stdin EOF closes the board the same way.

#include <cstdio>
#include <set>
#include <string>

// windows.h (via jsonline.hpp) must come first: MinGW defines __int64 there, which bdaqctrl.h needs.
#include "common/jsonline.hpp"

#include <bdaqctrl.h>

using namespace Automation::BDaq;
using hwcli::Request;

namespace {

constexpr int kChannels = 16;
constexpr int kPorts = 2;

InstantDoCtrl *outputs = nullptr;
InstantDiCtrl *inputs = nullptr;
InstantAiCtrl *analog = nullptr;
unsigned safe_do_mask = 0;
std::set<long> configured;
std::string signal_names[] = {"SingleEnded", "Differential", "PseudoDifferential"};

bool succeeded(ErrorCode code) { return BioFailed(code) == false; }

std::string error_text(const char *what, ErrorCode code) { return std::string(what) + " failed " + hwcli::hex(code); }

// setSelectedDevice fails for very different reasons; name the one that happened, so the operator
// knows whether to check the card list or to close whatever already holds the board. DAQNavi hands
// out write privilege exclusively, so a second testStand instance gets ErrorPrivilegeNotAvailable.
std::string select_error(const std::string &description, const char *what, ErrorCode code) {
    if (code == ErrorPrivilegeNotAvailable) {
        return "Device '" + description + "' is already open in another process; close the other " +
               "testStand instance and retry: " + error_text(what, code);
    }
    if (code == ErrorDeviceNotExist || code == ErrorDeviceUnrecognized) {
        return "Device '" + description + "' not in DAQNavi list: " + error_text(what, code);
    }
    return "Device '" + description + "' cannot be selected: " + error_text(what, code);
}

std::string signal_name(long type) { return type >= 0 && type <= 2 ? signal_names[type] : "SingleEnded"; }

void release() {
    if (outputs != nullptr) outputs->Dispose();
    if (inputs != nullptr) inputs->Dispose();
    if (analog != nullptr) analog->Dispose();
    outputs = nullptr;
    inputs = nullptr;
    analog = nullptr;
    configured.clear();
}

std::string upper(std::string text) {
    for (char &c : text) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
    return text;
}

ErrorCode read_ports(const std::string &kind, unsigned &mask) {
    uint8 data[kPorts] = {0, 0};
    ErrorCode code = kind == "DO" ? outputs->Read(0, kPorts, data) : inputs->Read(0, kPorts, data);
    mask = static_cast<unsigned>(data[0]) | static_cast<unsigned>(data[1]) << 8;
    return code;
}

ErrorCode write_safe_mask() {
    uint8 data[kPorts] = {static_cast<uint8>(safe_do_mask & 0xFF), static_cast<uint8>((safe_do_mask >> 8) & 0xFF)};
    return outputs->Write(0, kPorts, data);
}

void enumerate() {
    InstantAiCtrl *probe = InstantAiCtrl::Create();
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
    std::string description = hwcli::text(request, "description", "PCI-1710L,BID#15");
    long mask = hwcli::integer(request, "safe_do_mask", 0);
    if (mask < 0 || mask > 0xFFFF) return hwcli::fail("safe_do_mask must be 0..65535");
    release();
    outputs = InstantDoCtrl::Create();
    inputs = InstantDiCtrl::Create();
    analog = InstantAiCtrl::Create();
    std::wstring wide = hwcli::wide(description);
    ErrorCode code = outputs->setSelectedDevice(DeviceInformation(wide.c_str(), ModeWrite));
    if (!succeeded(code)) {
        release();
        return hwcli::fail(select_error(description, "DO setSelectedDevice", code));
    }
    code = inputs->setSelectedDevice(DeviceInformation(wide.c_str(), ModeRead));
    if (!succeeded(code)) {
        release();
        return hwcli::fail(select_error(description, "DI setSelectedDevice", code));
    }
    // AI channel properties (signal type, range) are only writable in ModeWrite.
    code = analog->setSelectedDevice(DeviceInformation(wide.c_str(), ModeWrite));
    if (!succeeded(code)) {
        release();
        return hwcli::fail(select_error(description, "AI setSelectedDevice", code));
    }
    safe_do_mask = static_cast<unsigned>(mask);
    code = write_safe_mask();
    if (!succeeded(code)) {
        release();
        return hwcli::fail(error_text("DO safe mask write", code));
    }
    hwcli::ok("opened", "{\"description\":" + hwcli::quote(description) +
                            ",\"safe_do_mask\":" + std::to_string(safe_do_mask) + "}");
}

void close() {
    ErrorCode code = outputs != nullptr ? write_safe_mask() : Success;
    release();
    if (!succeeded(code)) return hwcli::fail("Closed, but safe_state failed: " + error_text("DO write", code));
    hwcli::ok("Closed after safe_state", "{\"open\":false}");
}

bool valid_channel(long channel) { return channel >= 0 && channel < kChannels; }

void handle(const Request &request) {
    std::string command = hwcli::text(request, "cmd");
    if (command == "ping") return hwcli::ok("pong", "{}");
    if (command == "enumerate") return enumerate();
    if (command == "open") return open(request);
    if (command == "close") return close();
    if (outputs == nullptr) return hwcli::fail("Not open");

    if (command == "configure_ai") {
        long channel = hwcli::integer(request, "channel", -1);
        long signal_type = hwcli::integer(request, "signal_type", 0);
        long value_range = hwcli::integer(request, "value_range", V_Neg10To10);
        if (!valid_channel(channel)) return hwcli::fail("channel must be 0..15");
        AiChannel &item = analog->getChannels()->getItem(channel);
        ErrorCode code = Success;
        // The L model reports single-ended channels whose type cannot be "set" to the same value.
        if (item.getSignalType() != static_cast<AiSignalType>(signal_type)) {
            code = item.setSignalType(static_cast<AiSignalType>(signal_type));
            if (!succeeded(code)) return hwcli::fail(error_text("setSignalType", code));
        }
        code = item.setValueRange(static_cast<ValueRange>(value_range));
        if (!succeeded(code)) return hwcli::fail(error_text("setValueRange", code));
        configured.insert(channel);
        return hwcli::ok("AI channel configured",
                         "{\"channel\":" + std::to_string(channel) + ",\"signal_type\":" + std::to_string(signal_type) +
                             ",\"value_range\":" + std::to_string(value_range) +
                             ",\"signal\":" + hwcli::quote(signal_name(signal_type)) + "}");
    }
    if (command == "read_voltage") {
        long channel = hwcli::integer(request, "channel", -1);
        if (!valid_channel(channel)) return hwcli::fail("channel must be 0..15");
        if (configured.count(channel) == 0) return hwcli::fail("AI channel not configured — call configure_ai first");
        uint16 raw[4] = {0, 0, 0, 0};
        double volts = 0;
        ErrorCode code = analog->ReadAny(channel, 1, raw, &volts);
        if (!succeeded(code)) return hwcli::fail(error_text("AI ReadAny", code));
        AiChannel &item = analog->getChannels()->getItem(channel);
        char number[32];
        std::snprintf(number, sizeof number, "%.9g", volts);
        return hwcli::ok("AI" + std::to_string(channel) + " = " + number + " V",
                         "{\"channel\":" + std::to_string(channel) + ",\"volts\":" + number +
                             ",\"raw\":" + std::to_string(raw[0]) +
                             ",\"signal\":" + hwcli::quote(signal_name(item.getSignalType())) +
                             ",\"value_range\":" + std::to_string(static_cast<int>(item.getValueRange())) + "}");
    }
    if (command == "set_level") {
        long channel = hwcli::integer(request, "channel", -1);
        if (!valid_channel(channel)) return hwcli::fail("channel must be 0..15");
        bool level = hwcli::flag(request, "level");
        ErrorCode code = outputs->WriteBit(channel / 8, channel % 8, level ? 1 : 0);
        if (!succeeded(code)) return hwcli::fail(error_text("WriteBit", code));
        return hwcli::ok("DO set (actuates)",
                         "{\"channel\":" + std::to_string(channel) + ",\"level\":" + hwcli::boolean(level) + "}");
    }
    if (command == "read_bit") {
        long channel = hwcli::integer(request, "channel", -1);
        if (!valid_channel(channel)) return hwcli::fail("channel must be 0..15");
        std::string kind = hwcli::text(request, "kind", "DI");
        uint8 value = 0;
        ErrorCode code = upper(kind) == "DO" ? outputs->ReadBit(channel / 8, channel % 8, &value)
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
        ErrorCode code = write_safe_mask();
        if (!succeeded(code)) return hwcli::fail(error_text("DO safe mask write", code));
        return hwcli::ok("DO safe_state applied", "{\"safe_do_mask\":" + std::to_string(safe_do_mask) + "}");
    }
    hwcli::fail("Unknown command " + command, false);
}

}  // namespace

int main() {
    int result = hwcli::serve(handle);
    if (outputs != nullptr) {
        write_safe_mask();
        release();
    }
    return result;
}
