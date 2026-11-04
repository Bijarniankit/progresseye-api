# ProgressEye Phase 11 Entity-Relationship Diagram (ERD)

## Overview
This diagram models the database schema for Phase 11 multi-tenancy foundation in `progresseye-api`. Every tenant-scoped entity enforces `school_id NOT NULL UUID` and PostgreSQL Row-Level Security (RLS).

```mermaid
erDiagram
    ORGANIZATION {
        uuid id PK
        string name
        string slug
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    SCHOOL {
        uuid id PK
        uuid organization_id FK
        string slug
        string name
        boolean is_active
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    ACADEMIC_YEAR {
        uuid id PK
        uuid school_id FK
        string name
        date start_date
        date end_date
        boolean is_current
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    USER {
        uuid id PK
        uuid school_id FK
        citext email
        string phone
        string password_hash
        string first_name
        string last_name
        boolean is_active
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    SESSION {
        uuid id PK
        uuid school_id FK
        uuid user_id FK
        string token_hash
        string user_agent
        string ip_address
        timestamp expires_at
        timestamp revoked_at
        timestamp created_at
        timestamp updated_at
    }

    ROLE {
        uuid id PK
        uuid school_id FK
        string name
        string slug
        string description
        boolean is_system
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    PERMISSION {
        uuid id PK
        string code
        string module
        string description
        timestamp created_at
    }

    ROLE_PERMISSION {
        uuid id PK
        uuid school_id FK
        uuid role_id FK
        uuid permission_id FK
        timestamp created_at
    }

    USER_ROLE {
        uuid id PK
        uuid school_id FK
        uuid user_id FK
        uuid role_id FK
        timestamp created_at
    }

    AUDIT_LOG {
        uuid id PK
        timestamp created_at PK
        uuid school_id FK
        uuid user_id FK
        string action
        string resource
        string resource_id
        string ip_address
        string user_agent
        jsonb payload
    }

    OUTBOX_EVENT {
        uuid id PK
        uuid school_id FK
        string event_type
        jsonb payload
        string status
        int retry_count
        timestamp processed_at
        string error
        timestamp created_at
        timestamp updated_at
    }

    COUNTER {
        uuid id PK
        uuid school_id FK
        uuid academic_year_id FK
        string sequence_name
        bigint current_value
        timestamp created_at
        timestamp updated_at
    }

    PUBLIC_LEAD {
        uuid id PK
        string type
        string name
        citext email
        string school_name
        string message
        string status
        string consent_text
        timestamp consented_at
        string ip_address_hash
        string user_agent
        string idempotency_key
        timestamp retention_until
        timestamp notified_at
        timestamp created_at
        timestamp updated_at
    }

    ORGANIZATION ||--o{ SCHOOL : "aggregates"
    SCHOOL ||--o{ ACADEMIC_YEAR : "operates"
    SCHOOL ||--o{ USER : "employs"
    SCHOOL ||--o{ SESSION : "tracks"
    USER ||--o{ SESSION : "owns"
    SCHOOL ||--o{ ROLE : "configures"
    ROLE ||--o{ ROLE_PERMISSION : "grants"
    PERMISSION ||--o{ ROLE_PERMISSION : "defines"
    USER ||--o{ USER_ROLE : "possesses"
    ROLE ||--o{ USER_ROLE : "assigned_to"
    SCHOOL ||--o{ AUDIT_LOG : "records"
    USER ||--o{ AUDIT_LOG : "generates"
    SCHOOL ||--o{ OUTBOX_EVENT : "emits"
    SCHOOL ||--o{ COUNTER : "sequences"
    ACADEMIC_YEAR ||--o{ COUNTER : "scopes"
```
