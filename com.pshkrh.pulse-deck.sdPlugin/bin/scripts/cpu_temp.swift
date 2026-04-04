#!/usr/bin/env swift
// Reads average CPU die temperature on Apple Silicon via IOHIDEventSystem.
// Mirrors the approach used by the Stats app (github.com/exelban/stats).
// Prints a single float (e.g. "42.3") to stdout, or "0.0" on failure.
// No sudo or special entitlements required.
import Foundation
import IOKit.hid

typealias CreateFn       = @convention(c) (CFAllocator?) -> IOHIDEventSystemClient
typealias SetMatchingFn  = @convention(c) (IOHIDEventSystemClient, CFDictionary) -> Void
typealias CopyServicesFn = @convention(c) (IOHIDEventSystemClient) -> CFArray?
typealias CopyPropertyFn = @convention(c) (IOHIDServiceClient, CFString) -> CFTypeRef?
typealias CopyEventFn    = @convention(c) (IOHIDServiceClient, Int64, Int32, Int64) -> OpaquePointer?
typealias GetFloatFn     = @convention(c) (OpaquePointer, Int32) -> Double

let lib = dlopen(nil, RTLD_LAZY)
func sym<T>(_ name: String, _ type: T.Type) -> T {
    unsafeBitCast(dlsym(lib, name)!, to: type)
}

let createFn = sym("IOHIDEventSystemClientCreate",       CreateFn.self)
let matchFn  = sym("IOHIDEventSystemClientSetMatching",  SetMatchingFn.self)
let svcsFn   = sym("IOHIDEventSystemClientCopyServices", CopyServicesFn.self)
let propFn   = sym("IOHIDServiceClientCopyProperty",     CopyPropertyFn.self)
let eventFn  = sym("IOHIDServiceClientCopyEvent",        CopyEventFn.self)
let floatFn  = sym("IOHIDEventGetFloatValue",            GetFloatFn.self)

// kIOHIDEventTypeTemperature = 15, field = IOHIDEventFieldBase(type) = type << 16
let kEventTypeTemperature: Int64 = 15
let kFieldTemperatureLevel: Int32 = Int32(15 << 16)

let client = createFn(kCFAllocatorDefault)
matchFn(client, ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 0x0005] as CFDictionary)

guard let services = svcsFn(client) as? [IOHIDServiceClient] else {
    print("0.0")
    exit(0)
}

var temps: [Double] = []
for svc in services {
    guard let name = propFn(svc, "Product" as CFString) as? String else { continue }
    // pACC/eACC MTR Temp = performance/efficiency CPU cores (older Apple Silicon)
    // PMU tdie = CPU die sensors (M4/M5 series)
    guard name.hasPrefix("pACC MTR Temp") ||
          name.hasPrefix("eACC MTR Temp") ||
          name.hasPrefix("PMU tdie") else { continue }
    guard let event = eventFn(svc, kEventTypeTemperature, 0, 0) else { continue }
    let value = floatFn(event, kFieldTemperatureLevel)
    if value > 0 && value < 120 { temps.append(value) }
}

if temps.isEmpty {
    print("0.0")
} else {
    let avg = temps.reduce(0, +) / Double(temps.count)
    print(String(format: "%.1f", avg))
}
