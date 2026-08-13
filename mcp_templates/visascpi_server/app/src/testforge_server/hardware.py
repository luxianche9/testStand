from testforge_runtime.contract import ActionSummary
from testforge_server.driver import VisaScpiDriver


class HardwareDriver(VisaScpiDriver):
    capabilities = ("visa", "scpi")
    actions = (
        ActionSummary(name="scpi_write", kind="hardware", description="Write one SCPI command."),
        ActionSummary(name="scpi_query", kind="hardware", description="Query one SCPI response."),
        ActionSummary(name="scpi_query_binary", kind="hardware", description="Query a bounded binary block."),
    )

    def read_status(self):
        return self.query("*STB?")

    def set_output(self, value: float):
        return self.write(f"SOUR:VOLT {value}")
