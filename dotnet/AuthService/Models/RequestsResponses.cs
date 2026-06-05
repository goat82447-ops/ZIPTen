namespace AuthService.Models;

public sealed record LoginRequest(string Email, string Password);

public sealed record LoginResponse(
    int Id,
    string FullName,
    string Email,
    string MobileNumber,
    string DefaultPickupAddress,
    string SecurityPin,
    string Message);

public sealed record VerifyPinRequest(int UserId, string Pin);

public sealed record PinVerificationResponse(
    int UserId,
    bool IsValid,
    string Message);
