import SwiftUI

enum Theme {
    static let bgPrimary    = Color(red: 0.039, green: 0.039, blue: 0.059) // #0a0a0f
    static let bgSecondary  = Color(red: 0.071, green: 0.071, blue: 0.102) // #12121a
    static let bgTertiary   = Color(red: 0.102, green: 0.102, blue: 0.180) // #1a1a2e
    static let border       = Color(red: 0.165, green: 0.165, blue: 0.243) // #2a2a3e
    static let textPrimary  = Color(red: 0.894, green: 0.894, blue: 0.922) // #e4e4e7
    static let textSecondary = Color(red: 0.631, green: 0.631, blue: 0.667) // #a1a1aa
    static let accent       = Color(red: 0.388, green: 0.400, blue: 0.945) // #6366f1
    static let accentHover  = Color(red: 0.506, green: 0.549, blue: 0.973) // #818cf8

    static let purple = Color(red: 0.659, green: 0.333, blue: 0.969)
    static let blue   = Color(red: 0.376, green: 0.647, blue: 0.980)
    static let green  = Color(red: 0.298, green: 0.784, blue: 0.573)
    static let yellow = Color(red: 0.980, green: 0.792, blue: 0.314)
    static let cyan   = Color(red: 0.208, green: 0.835, blue: 0.909)
    static let orange = Color(red: 0.984, green: 0.573, blue: 0.235)
    static let amber  = Color(red: 0.961, green: 0.620, blue: 0.043)
}

extension View {
    /// Rounded card with theme borders.
    func themeCard() -> some View {
        self
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
