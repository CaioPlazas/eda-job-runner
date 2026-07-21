// UART transmitter. Serializes one byte per request at the configured baud
// rate: one start bit (0), 8 data bits LSB-first, one stop bit (1).
module uart_tx #(
    parameter CLK_PER_BIT = 16
) (
    input  wire       clk,
    input  wire       rst_n,

    input  wire       tx_start,
    input  wire [7:0] tx_data,
    output reg        tx_busy,
    output reg        tx,          // serial line (idles high)
    output reg        tx_load      // one-cycle strobe when a byte is accepted
);
    localparam CNT_W = $clog2(CLK_PER_BIT);
    localparam [CNT_W-1:0] BIT_LAST = CNT_W'(CLK_PER_BIT - 1);

    localparam [1:0] S_IDLE  = 2'd0,
                     S_START = 2'd1,
                     S_DATA  = 2'd2,
                     S_STOP  = 2'd3;

    reg [1:0]       state;
    reg [CNT_W-1:0] baud_cnt;
    reg [2:0]       bit_idx;
    reg [7:0]       shifter;

    wire baud_tick = (baud_cnt == BIT_LAST);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state    <= S_IDLE;
            baud_cnt <= 0;
            bit_idx  <= 0;
            shifter  <= 8'd0;
            tx       <= 1'b1;
            tx_busy  <= 1'b0;
            tx_load  <= 1'b0;
        end else begin
            tx_load <= 1'b0;

            case (state)
                S_IDLE: begin
                    tx      <= 1'b1;
                    tx_busy <= 1'b0;
                    baud_cnt <= 0;
                    bit_idx  <= 0;
                    if (tx_start) begin
                        shifter <= tx_data;
                        tx_busy <= 1'b1;
                        tx_load <= 1'b1; // accept/pop the byte now, not at end
                        state   <= S_START;
                    end
                end

                S_START: begin
                    tx <= 1'b0; // start bit
                    if (baud_tick) begin
                        baud_cnt <= 0;
                        state    <= S_DATA;
                    end else begin
                        baud_cnt <= baud_cnt + 1'b1;
                    end
                end

                S_DATA: begin
                    tx <= shifter[0];
                    if (baud_tick) begin
                        baud_cnt <= 0;
                        shifter  <= {1'b0, shifter[7:1]};
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
                    tx <= 1'b1; // stop bit
                    if (baud_tick) begin
                        baud_cnt <= 0;
                        tx_busy  <= 1'b0;
                        state    <= S_IDLE;
                    end else begin
                        baud_cnt <= baud_cnt + 1'b1;
                    end
                end

                default: state <= S_IDLE;
            endcase
        end
    end
endmodule
