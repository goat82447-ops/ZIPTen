FROM mcr.microsoft.com/dotnet/sdk:10 AS build
WORKDIR /src

COPY ["AuthService.csproj", "."]
RUN dotnet restore "AuthService.csproj"
COPY . .
RUN dotnet build "AuthService.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "AuthService.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10
WORKDIR /app
COPY --from=publish /app/publish .

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost/health || exit 1

ENTRYPOINT ["dotnet", "AuthService.dll"]
