import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { RedisService } from "../../../infra/redis/redis.service";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get("live")
  @ApiOperation({
    summary: "Liveness probe",
    description: "Returns 200 if the process is up and running.",
  })
  @ApiResponse({ status: 200, description: "Process is alive" })
  getLive() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness probe",
    description:
      "Checks database and Redis connectivity. Returns 200 if ready, 503 if any service is down.",
  })
  @ApiResponse({ status: 200, description: "All dependencies are healthy" })
  @ApiResponse({ status: 503, description: "One or more dependencies are unavailable" })
  async getReady() {
    const isDbUp = await this.prisma.ping();
    const isRedisUp = await this.redis.ping();

    const details = {
      database: { status: isDbUp ? "up" : "down" },
      redis: { status: isRedisUp ? "up" : "down" },
    };

    if (!isDbUp || !isRedisUp) {
      throw new ServiceUnavailableException({
        status: "error",
        message: "One or more core dependencies are unavailable",
        details,
      });
    }

    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      details,
    };
  }
}
