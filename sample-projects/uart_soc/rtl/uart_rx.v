// UART receiver. Detects a start bit, then samples each of the 8 data bits at
// the midpoint of its bit period, LSB first, and strobes rx_valid for one
// cycle when a full byte has been assembled.
module uart_rx #(
    parameter CLK_PER_BIT = 16
) (
    input  wire       clk,
    input  wire       rst_n,

    input  wire       rx,          // serial line (idles high)
    output reg  [7:0] rx_data,
    output reg        rx_valid,
    output reg        rx_frame_err // stop bit was not high
);
    localparam CNT_W = $clog2(CLK_PER_BIT);
    localparam [CNT_W-1:0] BIT_LAST  = CNT_W'(CLK_PER_BIT - 1);
    localparam [CNT_W-1:0] HALF_LAST = CNT_W'(CLK_PER_BIT/2 - 1);

    localparam [1:0] S_IDLE  = 2'd0,
                     S_START = 2'd1,
                     S_DATA  = 2'd2,
                     S_STOP  = 2'd3;

    reg [1:0]       state;
    reg [CNT_W-1:0] baud_cnt;
    reg [2:0]       bit_idx;
    reg [7:0]       shifter;

    // Two-flop synchronizer for the asynchronous serial input.
    reg rx_meta, rx_sync;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rx_meta <= 1'b1;
            rx_sync <= 1'b1;
        end else begin
            rx_meta <= rx;
            rx_sync <= rx_meta;
        end
    end

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state        <= S_IDLE;
            baud_cnt     <= 0;
            bit_idx      <= 0;
            shifter      <= 8'd0;
            rx_data      <= 8'd0;
            rx_valid     <= 1'b0;
            rx_frame_err <= 1'b0;
        end else begin
            rx_valid <= 1'b0;

            case (state)
                S_IDLE: begin
                    baud_cnt <= 0;
                    bit_idx  <= 0;
                    if (rx_sync == 1'b0) begin // falling edge = start bit
                        state <= S_START;
                    end
                end

                // Wait half a bit period, then re-check we're still in the
                // start bit — rejects glitches — and align to bit midpoints.
                S_START: begin
                    if (baud_cnt == HALF_LAST) begin
                        baud_cnt <= 0;
                        if (rx_sync == 1'b0) begin
                            state <= S_DATA;
                        end else begin
                            state <= S_IDLE;
                        end
                    end else begin
                        baud_cnt <= baud_cnt + 1'b1;
                    end
                end

                S_DATA: begin
                    if (baud_cnt == BIT_LAST) begin
                        baud_cnt <= 0;
                        shifter  <= {rx_sync, shifter[7:1]};
                        if (bit_idx == 3'd7) begin
                            state <= S_STOP;
                        end else begin
                            bit_idx <= bit_idx + 1'b1;
                        end
                    end else begin
                        baud_cnt <= baud_cnt + 1'b1;
                    end
                end

                S_STOP: begin
                    if (baud_cnt == BIT_LAST) begin
                        baud_cnt     <= 0;
                        rx_data      <= shifter;
                        rx_valid     <= 1'b1;
                        rx_frame_err <= ~rx_sync; // stop bit should be high
                        state        <= S_IDLE;
                    end else begin
                        baud_cnt <= baud_cnt + 1'b1;
                    end
                end

                default: state <= S_IDLE;
            endcase
        end
    end
endmodule
