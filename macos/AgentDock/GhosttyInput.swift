import AppKit
import Carbon
import GhosttyKit

/// Opt-in diagnostics for the terminal surface: set AGENTDOCK_GHOSTTY_LOG=1.
enum GhosttyLog {
    static let enabled = ProcessInfo.processInfo.environment["AGENTDOCK_GHOSTTY_LOG"] == "1"

    static func write(_ message: String) {
        guard enabled else { return }
        FileHandle.standardError.write(Data("[ghostty] \(message)\n".utf8))
    }

    private static let rendererEventLock = NSLock()
    nonisolated(unsafe) private static var rendererEventCounts: [UInt32: Int] = [:]

    /// Called from the renderer thread, so this only counts and logs sparsely.
    static func rendererEvent(_ event: UInt32) {
        guard enabled else { return }
        rendererEventLock.lock()
        let count = (rendererEventCounts[event] ?? 0) + 1
        rendererEventCounts[event] = count
        rendererEventLock.unlock()
        if count <= 3 || count % 120 == 0 {
            FileHandle.standardError.write(Data("[ghostty] renderer event \(event) count=\(count)\n".utf8))
        }
    }
}

enum GhosttyInput {
    static func mods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods: UInt32 = GHOSTTY_MODS_NONE.rawValue
        if flags.contains(.shift) { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { mods |= GHOSTTY_MODS_CTRL.rawValue }
        if flags.contains(.option) { mods |= GHOSTTY_MODS_ALT.rawValue }
        if flags.contains(.command) { mods |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock) { mods |= GHOSTTY_MODS_CAPS.rawValue }

        let raw = flags.rawValue
        if raw & UInt(NX_DEVICERSHIFTKEYMASK) != 0 { mods |= GHOSTTY_MODS_SHIFT_RIGHT.rawValue }
        if raw & UInt(NX_DEVICERCTLKEYMASK) != 0 { mods |= GHOSTTY_MODS_CTRL_RIGHT.rawValue }
        if raw & UInt(NX_DEVICERALTKEYMASK) != 0 { mods |= GHOSTTY_MODS_ALT_RIGHT.rawValue }
        if raw & UInt(NX_DEVICERCMDKEYMASK) != 0 { mods |= GHOSTTY_MODS_SUPER_RIGHT.rawValue }

        return ghostty_input_mods_e(mods)
    }

    static func modifierFlags(_ mods: ghostty_input_mods_e) -> NSEvent.ModifierFlags {
        var flags = NSEvent.ModifierFlags(rawValue: 0)
        if mods.rawValue & GHOSTTY_MODS_SHIFT.rawValue != 0 { flags.insert(.shift) }
        if mods.rawValue & GHOSTTY_MODS_CTRL.rawValue != 0 { flags.insert(.control) }
        if mods.rawValue & GHOSTTY_MODS_ALT.rawValue != 0 { flags.insert(.option) }
        if mods.rawValue & GHOSTTY_MODS_SUPER.rawValue != 0 { flags.insert(.command) }
        return flags
    }

    /// Packed `ScrollMods`: bit 0 is precision, bits 1-3 are the momentum phase.
    static func scrollMods(precision: Bool, momentum: NSEvent.Phase) -> ghostty_input_scroll_mods_t {
        var value: Int32 = precision ? 1 : 0
        let phase: Int32
        switch momentum {
        case .began: phase = 1
        case .stationary: phase = 2
        case .changed: phase = 3
        case .ended: phase = 4
        case .cancelled: phase = 5
        case .mayBegin: phase = 6
        default: phase = 0
        }
        value |= phase << 1
        return value
    }

    static func mouseButton(_ buttonNumber: Int) -> ghostty_input_mouse_button_e {
        switch buttonNumber {
        case 0: GHOSTTY_MOUSE_LEFT
        case 1: GHOSTTY_MOUSE_RIGHT
        case 2: GHOSTTY_MOUSE_MIDDLE
        case 3: GHOSTTY_MOUSE_FOUR
        case 4: GHOSTTY_MOUSE_FIVE
        case 5: GHOSTTY_MOUSE_SIX
        case 6: GHOSTTY_MOUSE_SEVEN
        case 7: GHOSTTY_MOUSE_EIGHT
        case 8: GHOSTTY_MOUSE_NINE
        case 9: GHOSTTY_MOUSE_TEN
        case 10: GHOSTTY_MOUSE_ELEVEN
        default: GHOSTTY_MOUSE_UNKNOWN
        }
    }
}

extension NSEvent {
    /// Build a Ghostty key event. `text` and `composing` are left to the caller because
    /// they cannot be expressed safely with this method's lifetimes.
    func ghosttyKeyEvent(
        _ action: ghostty_input_action_e,
        translationMods: NSEvent.ModifierFlags? = nil
    ) -> ghostty_input_key_s {
        var event = ghostty_input_key_s()
        event.action = action
        event.keycode = UInt32(keyCode)
        event.text = nil
        event.composing = false
        event.mods = GhosttyInput.mods(modifierFlags)

        // macOS gives us no way to know which modifiers text translation consumed.
        // Control and command never translate; assume everything else did.
        event.consumed_mods = GhosttyInput.mods(
            (translationMods ?? modifierFlags).subtracting([.control, .command])
        )

        event.unshifted_codepoint = 0
        if type == .keyDown || type == .keyUp,
           let chars = characters(byApplyingModifiers: []),
           let codepoint = chars.unicodeScalars.first {
            event.unshifted_codepoint = codepoint.value
        }

        return event
    }

    /// Text for a key event, with control characters and function-key private-use
    /// codepoints stripped because Ghostty encodes those itself.
    var ghosttyCharacters: String? {
        guard let characters else { return nil }

        if characters.count == 1, let scalar = characters.unicodeScalars.first {
            if scalar.value < 0x20 {
                return self.characters(byApplyingModifiers: modifierFlags.subtracting(.control))
            }
            if scalar.value >= 0xF700 && scalar.value <= 0xF8FF {
                return nil
            }
        }

        return characters
    }
}
