cmake_minimum_required(VERSION 3.20)
project(testforge_hardware_cli LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(DAQNAVI_ROOT "$ENV{DAQNAVI_ROOT}" CACHE PATH "Advantech DAQNavi install root")
if(NOT DAQNAVI_ROOT OR DAQNAVI_ROOT STREQUAL "")
    set(DAQNAVI_ROOT "C:/Advantech/DAQNavi")
endif()

if(NOT EXISTS "${DAQNAVI_ROOT}/Inc/bdaqctrl.h")
    message(FATAL_ERROR "DAQNavi not found at ${DAQNAVI_ROOT} (expected Inc/bdaqctrl.h). Set DAQNAVI_ROOT.")
endif()

add_executable(hwcli_pci1710l hwcli_pci1710l.cpp)
add_executable(hwcli_pci1762 hwcli_pci1762.cpp)
foreach(target hwcli_pci1710l hwcli_pci1762)
    target_include_directories(${target} PRIVATE "${DAQNAVI_ROOT}/Inc" "${CMAKE_CURRENT_SOURCE_DIR}")
endforeach()
