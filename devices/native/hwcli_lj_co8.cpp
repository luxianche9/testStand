// hwcli_lj_co8: JSON-line bridge to a Sinoder LJ-CO-CPCI-8 (PXI-4281) 8-channel programmable capacitor.
//
// The vendor driver PXI4281.dll is a 32-bit LabWindows/CVI instrument driver on top of NI-VISA, so
// this bridge is built as a 32-bit exe (devices/native/build_x86.py) and the 64-bit backend talks to
// it over stdin/stdout. The DLL is loaded at run time by the first enumerate/open: their ``dll``
// field (or ``--dll <path>``) first, then the directory of this exe, then the DLL search path.
//
// Commands: ping, enumerate {dll}, open {resource ("" = first card found), dll}, close, identity,
// set_cap {channel, pf}, set_all {pf0..pf7}, reset, self_test.
// The card has no readback of the setting: the demo's control registers 0x100 + 4n read 0 whatever
// is set (checked on the bench), so a reply only says the driver accepted the value.
// Capacitance limits (5..1000 pF, 8 channels) come from PXI4281_api.h; the adapter checks them
// first and so does this bridge. The calibration writes in the API (SetBias, SaveBias, SetSN,
// WriteReg, SetStandBias) overwrite factory data on the card and are deliberately not exposed.

#include <string>

#include "common/jsonline.hpp"

using hwcli::Request;

namespace {

constexpr int kChannels = 8;
constexpr double kMinPf = 5.0;
constexpr double kMaxPf = 1000.0;
constexpr int kMaxCards = 20;

typedef int(__stdcall *QueryResourceNameFn)(int, unsigned short, int *, char *, int *);
typedef int(__stdcall *InitFn)(char *, unsigned short, unsigned short, unsigned int *);
typedef int(__stdcall *CloseFn)(unsigned int);
typedef int(__stdcall *ResetFn)(unsigned int);
typedef int(__stdcall *SelfTestFn)(unsigned int, short *, char *);
typedef int(__stdcall *RevisionFn)(unsigned int, char *, char *);
typedef int(__stdcall *ErrorMessageFn)(unsigned int, int, char *);
typedef int(__stdcall *SetCapFn)(unsigned int, unsigned int, double);
typedef int(__stdcall *SetCapAllFn)(unsigned int, double *);
typedef int(__stdcall *GetSnFn)(unsigned int, int *);
typedef int(__cdecl *GetSubStringFn)(const char *, unsigned int, char *);

struct Driver {
    HMODULE module = nullptr;
    std::string path;
    QueryResourceNameFn query = nullptr;
    InitFn init = nullptr;
    CloseFn close = nullptr;
    ResetFn reset = nullptr;
    SelfTestFn self_test = nullptr;
    RevisionFn revision = nullptr;
    ErrorMessageFn error_message = nullptr;
    SetCapFn set_cap = nullptr;
    SetCapAllFn set_all = nullptr;
    GetSnFn get_sn = nullptr;
    GetSubStringFn sub_string = nullptr;
};

Driver driver;
std::string dll_option;
unsigned int session = 0;
std::string session_resource;

std::string exe_directory() {
    wchar_t buffer[MAX_PATH];
    DWORD size = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    std::wstring path(buffer, size);
    size_t slash = path.find_last_of(L"\\/");
    return hwcli::narrow(path.substr(0, slash == std::wstring::npos ? 0 : slash).c_str());
}

template <typename T>
bool bind(const char *name, T &target, std::string &error) {
    target = reinterpret_cast<T>(GetProcAddress(driver.module, name));
    if (target == nullptr) error = std::string("PXI4281.dll has no export ") + name;
    return target != nullptr;
}

// Load PXI4281.dll once; false (unreachable) when it or its CVI/VISA runtime cannot be loaded.
bool load(const Request &request, std::string &error) {
    if (driver.module != nullptr) return true;
    std::string candidates[] = {hwcli::text(request, "dll"), dll_option, exe_directory() + "\\PXI4281.dll", "PXI4281.dll"};
    for (const std::string &candidate : candidates) {
        if (candidate.empty()) continue;
        // Let the DLL find cvirte.dll / visa32.dll next to itself as well as on PATH.
        HMODULE module = LoadLibraryExW(hwcli::wide(candidate).c_str(), nullptr,
                                        candidate.find('\\') != std::string::npos ? LOAD_WITH_ALTERED_SEARCH_PATH : 0);
        if (module != nullptr) {
            driver.module = module;
            driver.path = candidate;
            break;
        }
        error += (error.empty() ? "" : "; ") + ("LoadLibrary(" + candidate + ") failed, GetLastError " +
                                                 std::to_string(GetLastError()));
    }
    if (driver.module == nullptr) {
        error += "; install the LJ-CO-CPCI-8 software (CVI runtime + NI-VISA) or pass --dll";
        return false;
    }
    bool bound = bind("PXI4281_QueryResourceName", driver.query, error) && bind("PXI4281_init", driver.init, error) &&
                 bind("PXI4281_close", driver.close, error) && bind("PXI4281_reset", driver.reset, error) &&
                 bind("PXI4281_self_test", driver.self_test, error) &&
                 bind("PXI4281_revision_query", driver.revision, error) &&
                 bind("PXI4281_error_message", driver.error_message, error) &&
                 bind("PXI4281_capSetCapacitance", driver.set_cap, error) &&
                 bind("PXI4281_capSetCapacitanceAll", driver.set_all, error) &&
                 bind("PXI4281_GetSN", driver.get_sn, error) &&
                 bind("GetSubString", driver.sub_string, error);
    if (!bound) {
        FreeLibrary(driver.module);
        driver = Driver();
    }
    return bound;
}

std::string describe(const char *what, int status) {
    char message[256] = {0};
    if (driver.error_message != nullptr) driver.error_message(session, status, message);
    std::string text = std::string(what) + " failed status " + std::to_string(status) + " (" + hwcli::hex(status) + ")";
    return message[0] != 0 ? text + ": " + message : text;
}

std::string number(double value) {
    char buffer[32];
    std::snprintf(buffer, sizeof buffer, "%.6g", value);
    return buffer;
}

bool valid_pf(double pf) { return pf >= kMinPf && pf <= kMaxPf; }

// Resources as {"resource","slot"} objects; also used by open to pick the first card.
int query(std::string &list, std::string &first, std::string &error) {
    char names[1024] = {0};
    int slots[kMaxCards] = {0};
    int found = 0;
    int status = driver.query(kMaxCards, 1, &found, names, slots);
    if (status != 0 && found <= 0) {
        error = describe("PXI4281_QueryResourceName", status);
        return -1;
    }
    list = "[";
    for (int i = 0; i < found && i < kMaxCards; ++i) {
        char name[256] = {0};
        driver.sub_string(names, static_cast<unsigned>(i), name);
        if (i == 0) first = name;
        if (i > 0) list += ",";
        list += "{\"resource\":" + hwcli::quote(name) + ",\"slot\":" + std::to_string(slots[i]) + "}";
    }
    list += "]";
    return found;
}

void enumerate(const Request &request) {
    std::string error, list, first;
    if (!load(request, error)) return hwcli::fail(error, false);
    int found = query(list, first, error);
    if (found < 0) return hwcli::fail(error, false);
    hwcli::ok(std::to_string(found) + " card(s)", list);
}

void release() {
    if (session != 0) driver.close(session);
    session = 0;
    session_resource.clear();
}

void open(const Request &request) {
    std::string error;
    if (!load(request, error)) return hwcli::fail(error, false);
    release();
    std::string resource = hwcli::text(request, "resource");
    if (resource.empty()) {
        std::string list;
        if (query(list, resource, error) <= 0) {
            return hwcli::fail(error.empty() ? "No LJ-CO-CPCI-8 (PXI-4281) card found by VISA" : error, false);
        }
    }
    // IDQuery=1 checks the PCI vendor/model id; resetDevice=1 is what the vendor demo passes.
    unsigned int handle = 0;
    int status = driver.init(&resource[0], 1, 1, &handle);
    if (status != 0 || handle == 0) {
        return hwcli::fail("Card '" + resource + "' cannot be opened: " + describe("PXI4281_init", status), false);
    }
    session = handle;
    session_resource = resource;
    int serial = 0;
    int sn_status = driver.get_sn(session, &serial);
    hwcli::ok("opened", "{\"resource\":" + hwcli::quote(resource) + ",\"serialNumber\":" + std::to_string(serial) +
                            ",\"snStatus\":" + std::to_string(sn_status) + ",\"dll\":" + hwcli::quote(driver.path) +
                            "}");
}

void identity() {
    char driver_revision[256] = {0};
    char firmware_revision[256] = {0};
    int serial = 0;
    int sn_status = driver.get_sn(session, &serial);
    int rev_status = driver.revision(session, driver_revision, firmware_revision);
    hwcli::ok("identity", "{\"resource\":" + hwcli::quote(session_resource) + ",\"serialNumber\":" +
                              std::to_string(serial) + ",\"snStatus\":" + std::to_string(sn_status) +
                              ",\"driverRevision\":" + hwcli::quote(driver_revision) + ",\"firmwareRevision\":" +
                              hwcli::quote(firmware_revision) + ",\"revisionStatus\":" + std::to_string(rev_status) +
                              ",\"dll\":" + hwcli::quote(driver.path) + "}");
}

void handle(const Request &request) {
    std::string command = hwcli::text(request, "cmd");
    if (command == "ping") return hwcli::ok("pong", "{}");
    if (command == "enumerate") return enumerate(request);
    if (command == "open") return open(request);
    if (command == "close") {
        release();
        return hwcli::ok("closed", "{\"open\":false}");
    }
    if (session == 0) return hwcli::fail("Not open");

    if (command == "identity") return identity();
    if (command == "set_cap") {
        long channel = hwcli::integer(request, "channel", -1);
        if (channel < 0 || channel >= kChannels) return hwcli::fail("channel must be 0..7");
        auto it = request.find("pf");
        if (it == request.end() || it->second.kind != hwcli::Value::Number || !valid_pf(it->second.number)) {
            return hwcli::fail("pf must be a number in 5..1000");
        }
        double pf = it->second.number;
        int status = driver.set_cap(session, static_cast<unsigned>(channel), pf);
        if (status != 0) return hwcli::fail(describe("PXI4281_capSetCapacitance", status));
        return hwcli::ok("capacitance set (actuates)",
                         "{\"channel\":" + std::to_string(channel) + ",\"pf\":" + number(pf) + "}");
    }
    if (command == "set_all") {
        double values[kChannels];
        std::string list = "[";
        for (int n = 0; n < kChannels; ++n) {
            std::string key = "pf" + std::to_string(n);
            auto it = request.find(key);
            if (it == request.end() || it->second.kind != hwcli::Value::Number || !valid_pf(it->second.number)) {
                return hwcli::fail(key + " must be a number in 5..1000");
            }
            values[n] = it->second.number;
            list += (n > 0 ? "," : "") + number(values[n]);
        }
        int status = driver.set_all(session, values);
        if (status != 0) return hwcli::fail(describe("PXI4281_capSetCapacitanceAll", status));
        return hwcli::ok("all capacitances set (actuates)", "{\"pf\":" + list + "]}");
    }
    if (command == "reset") {
        int status = driver.reset(session);
        if (status != 0) return hwcli::fail(describe("PXI4281_reset", status));
        return hwcli::ok("reset (actuates)", "{}");
    }
    if (command == "self_test") {
        short result = -1;
        char message[256] = {0};
        int status = driver.self_test(session, &result, message);
        return hwcli::ok("self_test", "{\"status\":" + std::to_string(status) + ",\"result\":" +
                                          std::to_string(result) + ",\"message\":" + hwcli::quote(message) + "}");
    }
    hwcli::fail("Unknown command " + command, false);
}

}  // namespace

// wmain: the --dll path may hold non-ASCII characters that the ANSI argv would mangle.
int wmain(int argc, wchar_t **argv) {
    for (int i = 1; i + 1 < argc; ++i) {
        if (std::wstring(argv[i]) == L"--dll") dll_option = hwcli::narrow(argv[i + 1]);
    }
    int result = hwcli::serve(handle);
    release();
    return result;
}
