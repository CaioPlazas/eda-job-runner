// UART subsystem top level: a TX path (write FIFO -> uart_tx) and an RX path
// (uart_rx -> read FIFO). The serial tx line can be looped back to rx
// externally (the testbench does this) to exercise the whole datapath.
module uart_top #(
    parameter CLK_PER_BIT = 16,
    parameter FIFO_DEPTH  = 16
) (
    input  wire       clk,
    input  wire       rst_n,

    // Host-side write port (bytes to transmit)
    input  wire       wr_en,
    input  wire [7:0] wr_data,
    output wire       tx_full,

    // Host-side read port (received bytes)
    input  wire       rd_en,
    output wire [7:0] rd_data,
    output wire       rx_empty,

    // Serial pins
    output wire       uart_tx_pin,
    input  wire       uart_rx_pin,

    // Status
    output wire       rx_frame_err
);
    // ---------------- TX path ----------------
    wire       txf_empty;
    wire [7:0] txf_dout;
    wire       tx_busy;
    wire       tx_load;

    sync_fifo #(.WIDTH(8), .DEPTH(FIFO_DEPTH)) u_tx_fifo (
        .clk(clk), .rst_n(rst_n),
        .wr_en(wr_en), .wr_data(wr_data), .full(tx_full),
        .rd_en(tx_load), .rd_data(txf_dout), .empty(txf_empty),
        .level()
    );

    // Kick off a transmission whenever the TX FIFO has data and the
    // transmitter is idle. The transmitter pops the byte at load time
    // (tx_load), so the FIFO head has advanced well before the next byte is
    // requested — avoiding the end-of-frame re-latch race.
    wire tx_start = ~txf_empty & ~tx_busy;

    uart_tx #(.CLK_PER_BIT(CLK_PER_BIT)) u_tx (
        .clk(clk), .rst_n(rst_n),
        .tx_start(tx_start), .tx_data(txf_dout),
        .tx_busy(tx_busy), .tx(uart_tx_pin), .tx_load(tx_load)
    );

    // ---------------- RX path ----------------
    wire [7:0] rx_byte;
    wire       rx_valid;

    uart_rx #(.CLK_PER_BIT(CLK_PER_BIT)) u_rx (
        .clk(clk), .rst_n(rst_n),
        .rx(uart_rx_pin),
        .rx_data(rx_byte), .rx_valid(rx_valid), .rx_frame_err(rx_frame_err)
    );

    sync_fifo #(.WIDTH(8), .DEPTH(FIFO_DEPTH)) u_rx_fifo (
        .clk(clk), .rst_n(rst_n),
        .wr_en(rx_valid), .wr_data(rx_byte), .full(),
        .rd_en(rd_en), .rd_data(rd_data), .empty(rx_empty),
        .level()
    );
endmodule
