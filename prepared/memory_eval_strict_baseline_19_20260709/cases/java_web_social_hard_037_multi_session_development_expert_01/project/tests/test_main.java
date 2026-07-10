package com.circleconnect.nexus.tests;

import com.circleconnect.nexus.model.dto.CircleRequestDTO;
import com.circleconnect.nexus.model.dto.PledgeRequestDTO;
import com.circleconnect.nexus.service.PaymentGateway;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.times;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultHandlers.print;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Comprehensive integration tests that hit the full Spring stack
 * (controllers ⇢ services ⇢ repositories) with mocked external dependencies.
 *
 * These tests purposely do not touch the database and rely on the default
 * in-memory H2 instance configured for the `test` profile.
 */
@ExtendWith(SpringExtension.class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public class TestMain {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    /**
     * External payment processor is substituted with a Mockito mock to avoid
     * real network calls and charges.
     */
    @MockBean
    private PaymentGateway paymentGateway;

    @Nested
    @DisplayName("Circle lifecycle scenarios")
    class CircleControllerTests {

        @Test
        @DisplayName("POST /api/v1/circles – should create a circle and subsequently return it in list endpoint")
        void shouldCreateAndRetrieveCircle() throws Exception {
            // Given
            CircleRequestDTO requestBody = new CircleRequestDTO()
                    .setName("Weekend Hackers")
                    .setDescription("A circle for spontaneous side-projects")
                    .setVisibility("PUBLIC");

            // When
            String json = objectMapper.writeValueAsString(requestBody);
            String location = mockMvc.perform(post("/api/v1/circles")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(json))
                    .andDo(print())
                    .andExpect(status().isCreated())
                    .andExpect(header().string("Location", Matchers.startsWith("/api/v1/circles/")))
                    .andReturn()
                    .getResponse()
                    .getHeader("Location");

            // Then
            mockMvc.perform(get(location))
                   .andDo(print())
                   .andExpect(status().isOk())
                   .andExpect(jsonPath("$.name").value("Weekend Hackers"))
                   .andExpect(jsonPath("$.description").value("A circle for spontaneous side-projects"))
                   .andExpect(jsonPath("$.memberCount").value(1)); // creator is auto-added
        }

        @Test
        @DisplayName("POST /api/v1/circles – should reject blank name and return validation error")
        void shouldReturnValidationErrorWhenCircleNameBlank() throws Exception {
            CircleRequestDTO invalidRequest = new CircleRequestDTO()
                    .setName(" ")
                    .setDescription("Foo")
                    .setVisibility("PRIVATE");

            mockMvc.perform(post("/api/v1/circles")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(invalidRequest)))
                    .andDo(print())
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.errors[0].field").value("name"))
                    .andExpect(jsonPath("$.errors[0].message").value(Matchers.containsString("must not be blank")));
        }
    }

    @Nested
    @DisplayName("Pledge flow scenarios")
    class PledgeControllerTests {

        @Test
        @DisplayName("POST /api/v1/circles/{id}/pledges – should process pledge with mocked Stripe gateway")
        void shouldProcessPledgePayment() throws Exception {
            // Given
            UUID circleId = createCircleAndReturnId("Micro-Funding Circle");

            PledgeRequestDTO pledgeRequest = new PledgeRequestDTO()
                    .setAmount(BigDecimal.valueOf(35.50))
                    .setCurrency("USD")
                    .setPaymentMethodToken("tok_visa")
                    .setComment("Happy to help!")
                    .setPledgedAt(OffsetDateTime.now());

            Mockito.when(paymentGateway.chargePledge(eq(pledgeRequest.getPaymentMethodToken()),
                                                     eq(pledgeRequest.getAmount()),
                                                     eq(pledgeRequest.getCurrency())))
                   .thenReturn(true);

            // When / Then
            mockMvc.perform(post("/api/v1/circles/{id}/pledges", circleId)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(pledgeRequest)))
                   .andDo(print())
                   .andExpect(status().isCreated())
                   .andExpect(jsonPath("$.amount").value(35.50))
                   .andExpect(jsonPath("$.status").value("COMPLETED"));

            Mockito.verify(paymentGateway, times(1))
                   .chargePledge(any(), any(), any());
        }

        private UUID createCircleAndReturnId(String name) throws Exception {
            CircleRequestDTO dto = new CircleRequestDTO()
                    .setName(name)
                    .setDescription("Temp circle")
                    .setVisibility("PUBLIC");

            String location = mockMvc.perform(post("/api/v1/circles")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isCreated())
                    .andReturn()
                    .getResponse()
                    .getHeader("Location");

            assert location != null;
            String idPart = location.substring(location.lastIndexOf('/') + 1);
            return UUID.fromString(idPart);
        }
    }

    @Test
    @DisplayName("GET / – root endpoint should enforce HSTS headers for SSL-everywhere policy")
    void shouldContainStrictTransportSecurityHeader() throws Exception {
        mockMvc.perform(get("/"))
               .andExpect(status().isOk())
               .andExpect(header().exists("Strict-Transport-Security"))
               .andExpect(header().string("Strict-Transport-Security", Matchers.containsString("max-age")));
    }
}